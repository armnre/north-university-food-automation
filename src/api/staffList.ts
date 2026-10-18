import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { requireStaff } from '../server/core';

export default createEndpoint({
  description: 'Lists staff users with their roles (password hashes are never returned)',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const me = await requireStaff(input.token, 'users');
    const hide = me.role === 'SuperAdmin' ? '' : `WHERE u."role" NOT IN ('SuperAdmin','StudentAffairs')`;
    const r = await zite.sql({
      query: `SELECT u.id, u."username", u."fullName", u."role", u."status",
        (SELECT c.id FROM "ContractorsStaffUsers" l JOIN "Contractors" c ON c.id=l."contractorsId" WHERE l."staffUsersId"=u.id LIMIT 1) AS "contractorId",
        (SELECT c."name" FROM "ContractorsStaffUsers" l JOIN "Contractors" c ON c.id=l."contractorsId" WHERE l."staffUsersId"=u.id LIMIT 1) AS "contractorName",
        (SELECT c.id FROM "CafeteriasStaffUsers" l JOIN "Cafeterias" c ON c.id=l."cafeteriasId" WHERE l."staffUsersId"=u.id LIMIT 1) AS "cafeteriaId",
        (SELECT c."name" FROM "CafeteriasStaffUsers" l JOIN "Cafeterias" c ON c.id=l."cafeteriasId" WHERE l."staffUsersId"=u.id LIMIT 1) AS "cafeteriaName"
        FROM "StaffUsers" u ${hide} ORDER BY u."username"`,
    });
    return {
      users: r.rows.map((x) => ({
        id: String(x.id), username: String(x.username ?? ''), fullName: String(x.fullName ?? ''), role: String(x.role ?? ''), status: String(x.status ?? ''),
        contractorId: x.contractorId ? String(x.contractorId) : null, contractorName: x.contractorName ? String(x.contractorName) : null,
        cafeteriaId: x.cafeteriaId ? String(x.cafeteriaId) : null, cafeteriaName: x.cafeteriaName ? String(x.cafeteriaName) : null,
      })),
    };
  },
});
