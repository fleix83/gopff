import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'fs'

const sql = neon('postgresql://neondb_owner:npg_o0Nw5cTxEUFa@ep-old-grass-ale8zfkm-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require', { arrayMode: false, fullResults: false })

const kuerzelKanton = {
  AG: 'Aargau', AR: 'Appenzell Ausserrhoden', AI: 'Appenzell Innerrhoden',
  BL: 'Basel-Landschaft', BS: 'Basel-Stadt', BE: 'Bern', FR: 'Freiburg',
  GE: 'Genf', GL: 'Glarus', GR: 'Graubünden', JU: 'Jura', LU: 'Luzern',
  NE: 'Neuenburg', NW: 'Nidwalden', OW: 'Obwalden', SH: 'Schaffhausen',
  SZ: 'Schwyz', SO: 'Solothurn', SG: 'St. Gallen', TI: 'Tessin',
  TG: 'Thurgau', UR: 'Uri', VD: 'Waadt', VS: 'Wallis', ZG: 'Zug', ZH: 'Zürich'
}

function parseCSVLine(line) {
  const fields = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }
  fields.push(current)
  return fields
}

async function main() {
  const csv = readFileSync('swiss_companies_gopff.csv', 'utf-8')
  const lines = csv.split('\n').filter(l => l.trim())
  // Skip header
  const dataLines = lines.slice(1)
  console.log(`Total rows to import: ${dataLines.length}`)

  const BATCH_SIZE = 500
  let imported = 0
  let skipped = 0

  for (let i = 0; i < dataLines.length; i += BATCH_SIZE) {
    const batch = dataLines.slice(i, i + BATCH_SIZE)
    const values = []
    const params = []
    let paramIdx = 1

    for (const line of batch) {
      const fields = parseCSVLine(line)
      if (fields.length < 3) continue
      const name = fields[0].trim()
      const municipality = fields[1].trim() || null
      const cantonCode = fields[2].trim()
      const canton = kuerzelKanton[cantonCode] || cantonCode || null
      if (!name) continue
      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`)
      params.push(name, municipality, canton)
      paramIdx += 3
    }

    if (values.length === 0) continue

    const query = `INSERT INTO company (name, municipality, canton) VALUES ${values.join(', ')} ON CONFLICT (name, municipality, canton) DO NOTHING`
    try {
      await sql.query(query, params)
      imported += values.length
    } catch (e) {
      console.error(`Batch error at row ${i}:`, e.message)
      skipped += values.length
    }

    if ((i / BATCH_SIZE) % 20 === 0) {
      console.log(`Progress: ${Math.min(i + BATCH_SIZE, dataLines.length)} / ${dataLines.length}`)
    }
  }

  console.log(`Done! Imported: ${imported}, Skipped/errors: ${skipped}`)

  // Verify count
  const result = await sql`SELECT count(*) as cnt FROM company`
  console.log(`Total companies in DB: ${result[0].cnt}`)
}

main().catch(e => { console.error(e); process.exit(1) })
