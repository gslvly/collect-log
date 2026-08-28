import { describe, expect, it } from 'vitest';

import { can, canDeleteUser, type Permission, type Role } from './permissions.js';

const roles = ['user', 'admin', 'super_admin'] as const satisfies readonly Role[];

const permissionRows: readonly [string, Permission, readonly boolean[]][] = [
  ['查看全部数据采集表', 'viewTables', [true, true, true]],
  ['查询全部数据', 'queryData', [true, true, true]],
  ['导出数据', 'exportData', [true, true, true]],
  ['修改自己的密码', 'changeOwnPassword', [true, true, true]],
  ['创建数据采集表', 'createTable', [false, true, true]],
  ['读取建表模板', 'readTableTemplates', [false, true, true]],
  ['新增、改名、废弃字段', 'manageFields', [false, true, true]],
  ['物理删除字段、修改字段类型', 'destructiveFieldChanges', [false, true, true]],
  ['查看与轮换上报密钥', 'manageIngestSecret', [false, true, true]],
  ['变更表状态', 'changeTableStatus', [false, true, true]],
  ['删除数据采集表', 'deleteTable', [false, false, true]],
  ['创建 user 账户', 'createUser', [false, true, true]],
  ['创建 admin 账户', 'createAdmin', [false, false, true]],
];

describe('permission matrix', () => {
  it.each(permissionRows)('%s', (_label, permission, expected) => {
    expect(roles.map((role) => can(role, permission))).toEqual(expected);
  });

  it('deletes a user account only as admin or super_admin', () => {
    expect(roles.map((role) => canDeleteUser(role, 'user'))).toEqual([false, true, true]);
  });

  it('deletes an admin account only as super_admin', () => {
    expect(roles.map((role) => canDeleteUser(role, 'admin'))).toEqual([false, false, true]);
  });

  it('never deletes a super_admin account', () => {
    expect(roles.map((role) => canDeleteUser(role, 'super_admin'))).toEqual([false, false, false]);
  });
});
