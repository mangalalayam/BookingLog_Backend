import bcrypt from 'bcryptjs';
import {pool, transaction} from '../src/db.ts';
import {parse, phone} from '../src/http.ts';

/*
 * Create a tour company and its owner login from the command line:
 *
 *   npm run create-company -- "ABC Travels" "Owner Name" 9876543210 secret123
 *
 * (The same thing is available over HTTP as POST /admin/companies.)
 */
const [companyName, ownerName, ownerPhone, password] = process.argv.slice(2);

if (!companyName || !ownerName || !ownerPhone || !password) {
  console.error(
    'Usage: npm run create-company -- "<company name>" "<owner name>" <owner phone> <password>',
  );
  process.exit(1);
}
if (password.length < 6) {
  console.error('Password must be at least 6 characters.');
  process.exit(1);
}

try {
  const normalizedPhone = parse(phone, ownerPhone);
  const passwordHash = await bcrypt.hash(password, 10);

  const company = await transaction(async client => {
    const created = await client.query(
      'insert into companies (name) values ($1) returning id, name',
      [companyName.trim()],
    );
    await client.query(
      `insert into users (company_id, role, name, phone, password_hash)
       values ($1, 'owner', $2, $3, $4)`,
      [created.rows[0].id, ownerName.trim(), normalizedPhone, passwordHash],
    );
    return created.rows[0];
  });

  console.log(`Created "${company.name}" (${company.id}).`);
  console.log(`Owner logs in with phone ${normalizedPhone} and that password.`);
} catch (error: any) {
  if (error?.code === '23505') {
    console.error('That phone number already has an account.');
  } else {
    console.error(error?.message ?? error);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
