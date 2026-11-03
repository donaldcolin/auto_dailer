const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // one name everywhere: db/setup_db.sh writes SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.warn("WARNING: SUPABASE_URL and SUPABASE_KEY must be set in .env");
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

module.exports = supabase;
