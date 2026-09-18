import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8');
const env: Record<string, string> = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^#\s][^=]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim();
});

const supabase = createClient(env['NEXT_PUBLIC_SUPABASE_URL']!, env['SUPABASE_SERVICE_ROLE_KEY']!);

async function fixUser() {
  const email = 'Jasonlbester@gmail.com';
  
  console.log('Fetching users to find corrupted account...');
  const { data: users } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const corruptedUser = users.users.find(u => u.email === email.toLowerCase());

  if (corruptedUser) {
    console.log(`Found corrupted user ${corruptedUser.id}. Deleting it...`);
    const { error: deleteError } = await supabase.auth.admin.deleteUser(corruptedUser.id);
    if (deleteError) {
      console.error('Failed to delete user via API:', deleteError);
      return;
    }
    console.log('Deleted successfully. Wait 2 seconds...');
    await new Promise(r => setTimeout(r, 2000));
  } else {
    console.log('No existing user found in API.');
  }

  console.log(`Recreating user ${email}...`);
  const { data: userAuth, error: authError } = await supabase.auth.admin.createUser({
    email: email,
    password: 'Jason@Graceland7646',
    email_confirm: true,
    user_metadata: { display_name: 'Jason' },
  });

  if (authError) {
    console.error('Still failing to create user:', authError);
    return;
  }

  if (userAuth.user) {
    console.log(`User created successfully with ID: ${userAuth.user.id}`);
    
    console.log('Assigning ADMIN role...');
    await supabase.from('admin_roles').upsert({
      id: userAuth.user.id,
      role: 'ADMIN',
      display_name: 'Jason',
      active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    console.log('All done! Account is ready.');
  }
}

fixUser();
