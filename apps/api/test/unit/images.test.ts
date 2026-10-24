import { describe, expect, it } from 'vitest';
import { sniffImage, stripJpegExif } from '../../src/services/images.js';

describe('image helpers', () => {
  it('sniffs by magic bytes only', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(Buffer.from('RIFF0000WEBPVP8 ', 'ascii'))).toBe('webp');
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });
  it('strips EXIF APP1 segment from JPEG', () => {
    const exif = Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
    const out = stripJpegExif(Buffer.concat([Buffer.from([0xff, 0xd8]), exif, app0, sos]));
    expect(out.includes(Buffer.from('Exif'))).toBe(false);
    expect(out.includes(app0)).toBe(true);
    expect(out.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });
});
