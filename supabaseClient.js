// supabaseClient.js
// Supabase client setup (CommonJS version) — is file ko apne backend project me require karke use karo

const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Supabase URL ya Key missing hai. .env file me SUPABASE_URL aur SUPABASE_ANON_KEY set karo, aur Render dashboard ke Environment tab me bhi add karo.'
  )
}

const supabase = createClient(supabaseUrl, supabaseKey)

module.exports = { supabase }

/*
  USAGE EXAMPLE:
  ----------------------------------------
  const { supabase } = require('./supabaseClient')

  // Data fetch karna
  const { data, error } = await supabase
    .from('your_table_name')
    .select('*')

  // Data insert karna
  const { data, error } = await supabase
    .from('your_table_name')
    .insert([{ column1: 'value1', column2: 'value2' }])

  // Data update karna
  const { data, error } = await supabase
    .from('your_table_name')
    .update({ column1: 'new_value' })
    .eq('id', 1)

  // Data delete karna
  const { data, error } = await supabase
    .from('your_table_name')
    .delete()
    .eq('id', 1)
  ----------------------------------------
*/
