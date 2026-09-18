import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// Load env vars
const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8');
const env: Record<string, string> = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^#\s][^=]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim();
});

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'];

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createAdmin() {
  const email = 'Jasonlbester@gmail.com';
  const password = 'Jason@Graceland7646';
  const name = 'Jason';

  console.log(`Creating user ${email}...`);

  // 1. Create the user using the official admin API (handles all internal auth tables securely)
  const { data: userAuth, error: authError } = await supabase.auth.admin.createUser({
    email: email,
    password: password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });

  if (authError) {
    if (authError.message.includes('already been registered')) {
      console.log('User already exists in Auth. Fetching ID...');
      
      // Get the existing user
      const { data: listData } = await supabase.auth.admin.listUsers();
      const existing = listData.users.find(u => u.email === email.toLowerCase());
      
      if (existing) {
        console.log(`Found user ${existing.id}. Updating password...`);
        await supabase.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
        await upsertRole(existing.id, name);
      }
    } else {
      console.error('Error creating user:', authError);
    }
    return;
  }

  if (userAuth.user) {
    console.log(`User created with ID: ${userAuth.user.id}`);
    await upsertRole(userAuth.user.id, name);
  }
}

async function upsertRole(userId: string, name: string) {
  console.log('Upserting admin role...');
  const { error: roleError } = await supabase.from('admin_roles').upsert({
    id: userId,
    role: 'ADMIN',
    display_name: name,
    active: true,
    updated_at: new Date().toISOString()
  }, { onConflict: 'id' });

  if (roleError) {
    console.error('Error assigning role:', roleError);
  } else {
    console.log('Successfully assigned ADMIN role!');
  }
}

createAdmin();
