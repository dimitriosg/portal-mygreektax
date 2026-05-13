import { createClient } from "@supabase/supabase-js";

const USAGE = `Usage: node scripts/grant-admin.mjs --email admin@example.com

Required environment variables:
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_URL (or VITE_SUPABASE_URL)`;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    email: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--email") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --email.");
      }
      options.email = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function normalizeEmail(email) {
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

function getUserEmails(user) {
  const emails = new Set();

  const primaryEmail = normalizeEmail(user.email);
  if (primaryEmail) emails.add(primaryEmail);

  for (const identity of user.identities ?? []) {
    const identityEmail = normalizeEmail(identity.email ?? identity.identity_data?.email);
    if (identityEmail) emails.add(identityEmail);
  }

  return emails;
}

async function findUserByEmail(supabase, email) {
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Failed to list auth users: ${error.message}`);
    }

    const match = (data.users ?? []).find((user) => getUserEmails(user).has(email));
    if (match) {
      return match;
    }

    if (!data.nextPage || data.users.length === 0 || page >= data.lastPage) {
      return null;
    }

    page = data.nextPage;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const email = normalizeEmail(options.email);
  if (!email) {
    throw new Error(`An email is required.\n\n${USAGE}`);
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(`Missing required environment variables.\n\n${USAGE}`);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const authUser = await findUserByEmail(supabase, email);
  if (!authUser) {
    throw new Error(
      `No Supabase Auth user found for ${email}. Create the user manually in Supabase Auth first.`,
    );
  }

  const { data: existingRole, error: existingRoleError } = await supabase
    .from("user_roles")
    .select("id")
    .eq("user_id", authUser.id)
    .eq("role", "admin")
    .maybeSingle();

  if (existingRoleError) {
    throw new Error(`Failed to check existing admin role: ${existingRoleError.message}`);
  }

  if (existingRole) {
    console.log(`Admin role already present for ${email}.`);
    return;
  }

  const { error: insertError } = await supabase.from("user_roles").insert({
    user_id: authUser.id,
    role: "admin",
  });

  if (insertError) {
    throw new Error(`Failed to grant admin role: ${insertError.message}`);
  }

  console.log(`Granted admin role to ${email}.`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown error.");
});
