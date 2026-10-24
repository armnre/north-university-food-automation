import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button, type ButtonProps } from '@project/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@project/components/ui/alert-dialog';
import { errMsg } from '../lib/format';

type Props = { title: string; description: ReactNode; confirmLabel: string; action: () => Promise<string | void>; children: ReactNode } & Pick<ButtonProps, 'variant' | 'size' | 'className'>;

/** Button that asks for confirmation, runs the action, and toasts the outcome. */
export default function ConfirmButton({ title, description, confirmLabel, action, children, ...btn }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { const msg = await action(); if (msg) toast.success(msg); setOpen(false); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <Button type="button" {...btn} disabled={busy} onClick={() => setOpen(true)}>{busy && <Loader2 className="ms-1.5 h-3.5 w-3.5 animate-spin" />}{children}</Button>
      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={busy}>انصراف</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); run(); }}>{busy && <Loader2 className="ms-1.5 h-4 w-4 animate-spin" />}{confirmLabel}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
