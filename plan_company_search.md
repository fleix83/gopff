# Company Search Pipeline — pg_trgm + Debounced Server-Side Search

## Context
The app currently loads ALL companies into memory and filters client-side. With 778k Swiss companies from the Zefix CSV import, this approach is untenable. We need server-side trigram search with debouncing.

## Step 1: Database Setup (Neon SQL)

Run these SQL statements in order:

```sql
-- 1a. Enable trigram extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1b. Replace unique constraint (allow same company name in different municipalities)
ALTER TABLE company DROP CONSTRAINT IF EXISTS company_name_key;
ALTER TABLE company ADD CONSTRAINT company_name_municipality_canton_key
  UNIQUE (name, municipality, canton);
```

## Step 2: CSV Import Script

Create `import_companies.js` — one-time Node.js script that:
- Reads `swiss_companies_gopff.csv` (778k rows)
- Maps CSV columns: `company_name` → `name`, `municipality`, `canton` (convert 2-letter code to full name via `kuerzelKanton` mapping)
- Batch inserts 500 rows at a time using `INSERT ... ON CONFLICT (name, municipality, canton) DO NOTHING`
- Uses the same `@neondatabase/serverless` neon() connection

## Step 3: Create Trigram Index (after import)

```sql
CREATE INDEX idx_company_name_trgm ON company USING GIN (name gin_trgm_ops);
```

## Step 4: Update `app.js`

### 4a. Add debounce utility (top of setup)
```js
function debounce(fn, delay) {
  let timer = null
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay) }
}
```

### 4b. Add new reactive state
```js
const companySearchResults = ref([])
const companySearchLoading = ref(false)
```

### 4c. Add `searchCompanies()` function
Server-side search with ILIKE + trigram index, LIMIT 15, min 2 chars. Prioritize names starting with query, then shorter names.

```js
async function searchCompanies(query) {
  const q = query.trim()
  if (q.length < 2) {
    companySearchResults.value = []
    return
  }
  companySearchLoading.value = true
  try {
    const rows = await sql`
      SELECT id, name, municipality, canton, category_id
      FROM company
      WHERE name ILIKE ${'%' + q + '%'}
      ORDER BY
        (name ILIKE ${q + '%'}) DESC,
        length(name) ASC
      LIMIT 15
    `
    companySearchResults.value = rows
  } catch (e) {
    console.error('Company search failed:', e)
    companySearchResults.value = []
  }
  companySearchLoading.value = false
}
```

### 4d. Add debounced watcher on `companySearch`
```js
const debouncedCompanySearch = debounce(searchCompanies, 300)
watch(companySearch, (val) => { if (!form.value.company_id) debouncedCompanySearch(val) })
```

### 4e. Replace `gefilterteCompanies` computed
Use `companySearchResults.value` instead of filtering `companies.value`.

### 4f. Fix `selectedCompanyName`
Store full selected company object instead of looking it up in `companies.value`.

### 4g. Remove `ladeCompanies()` from `onMounted`
Remove from `Promise.all(...)` on line 844. Keep `ladeCompanies()` function for admin use only.

### 4h. Fix `companyErstellen()` duplicate handling (line 484-488)
Replace `companies.value.find(...)` with SQL query to find existing company.

### 4i. Update admin views — 3 places that use `companies.value`:
1. **`gefilterteFirmen`** (line 601): Convert to debounced server-side search (same pattern)
2. **`editBeitragGefilterteCompanies`** (line 738): Convert to debounced server-side search
3. **`editBeitragCompanyName`** (line 744): Use stored object instead of `companies.value.find()`

## Step 5: Update `index.html`

### 5a. Company search dropdown — add states:
- Loading indicator: `<li v-if="companySearchLoading">Suche...</li>`
- Empty state: `<li v-if="...">Kein Unternehmen gefunden</li>`
- Min chars hint: `<li v-if="companySearch.length > 0 && companySearch.length < 2">Mind. 2 Zeichen...</li>`

### 5b. Show municipality + canton in dropdown results
Essential for disambiguating companies with the same name (e.g. "Migros" in multiple municipalities).

### 5c. Same changes for admin company dropdowns

## Step 6: CSS (`style.css`)

Add styles for `.search-loading`, `.search-empty`, `.search-hint` states.

## Files Modified
- `app.js` — core search logic refactor
- `index.html` — dropdown template updates
- `style.css` — new search state styles
- `import_companies.js` — **new file**, one-time import script

## Verification
1. Run SQL steps 1 & 3 in Neon console
2. Run `node import_companies.js` and verify row count
3. Test search: type 2+ chars → results appear within 500ms
4. Test disambiguation: search "Migros" → shows municipality/canton per result
5. Test "add new company" flow still works
6. Test admin company editor search works
7. Test post editor company search works
