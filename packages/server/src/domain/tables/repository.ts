export type { FieldChangeResult } from './repository.fields.js';
export { translateFieldKeyConflict } from './repository.rows.js';
export { TableRepository, type CreateTableResult } from './repository.tables.js';

import { TableRepository } from './repository.tables.js';

export const tableRepository = new TableRepository();
