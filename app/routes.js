//
// For guidance on how to create routes see:
// https://prototype-kit.service.gov.uk/docs/create-routes
//

const govukPrototypeKit = require('govuk-prototype-kit')
const router = govukPrototypeKit.requests.setupRouter()
const fs = require('fs')
const path = require('path')

// =============================================================================
// PROTOTYPE ONLY — CSV DATA LAYER
// =============================================================================
// In production, test data will come from an API or database. This CSV parsing
// code exists solely to drive the prototype with realistic data and should not
// be carried forward into any production build.
//
// The CSV (app/data/price-list.csv) is a full export of the current price list.
// On first request, the file is read once, all active rows are parsed and cached
// in memory. Restarting the server clears the cache and re-reads the file.
// =============================================================================

// -----------------------------------------------------------------------------
// CSV parser
// Handles quoted fields that contain commas (e.g. "Cattle Packages, Sheep / Goat Packages")
// and escaped double-quotes inside quoted fields.
// -----------------------------------------------------------------------------
function parseCSVLine (line) {
  const fields = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // Two consecutive quotes inside a quoted field = literal quote character
      if (inQuotes && line[i + 1] === '"') {
        field += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields
}

function parseCSV (text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(l => l.trim())
    .map(parseCSVLine)
}

// -----------------------------------------------------------------------------
// Derived fields
// The CSV does not have dedicated columns for species, age or clinical purpose.
// These are inferred from the data we do have. In production, the data source
// should provide these as proper structured fields.
// -----------------------------------------------------------------------------

// Species: use col 14 (Species List) if populated, otherwise infer from
// col 15 (Price List Categories List) which contains strings like "Cattle Packages".
function deriveSpecies (speciesList, categories) {
  if (speciesList && speciesList.trim()) return speciesList.trim()
  const cats = categories || ''
  if (cats.includes('Cattle')) return 'Cattle'
  if (cats.includes('Sheep / Goat')) return 'Sheep / Goat'
  if (cats.includes('Pig')) return 'Pig'
  if (cats.includes('Avian')) return 'Avian'
  if (cats.includes('Equine')) return 'Equine'
  if (cats.includes('Camelid')) return 'Camelid'
  return ''
}

// Age group: extracted from keywords in the test description (col 4).
// The CSV has no dedicated age column.
function deriveAge (description) {
  const d = description.toLowerCase()
  if (/1.?5 day/.test(d)) return '1–5 days'
  if (/6 (to|day) 21 day|6-21 day/.test(d)) return '6–21 days'
  if (/6 day to 6 week|peri.?weaned/.test(d)) return '6 days–6 weeks'
  if (/over 6 weeks/.test(d)) return '6+ weeks'
  if (/from 22 days|22 day/.test(d)) return '22+ days'
  if (/older than 2 weeks/.test(d)) return '2+ weeks'
  if (/\badult\b/.test(d)) return 'Adult'
  return ''
}

// Clinical purpose: mapped from keywords in the test description (col 4).
// Col 24 (Diseases List) exists in the CSV but is unpopulated.
function deriveClinicalPurpose (description) {
  const d = description.toLowerCase()
  if (/abortion|stillbirth/.test(d)) return 'Abortion / Stillbirth'
  if (/respiratory/.test(d)) return 'Respiratory disease'
  if (/enteric/.test(d)) return 'Enteric disease'
  if (/worm egg|fluke|parasite|coccidi/.test(d)) return 'Parasitology'
  if (/histopathology|histology/.test(d)) return 'Histopathology'
  if (/\bmilk\b/.test(d)) return 'Milk testing'
  if (/post mortem/.test(d)) return 'Post mortem'
  if (/flock screen/.test(d)) return 'Flock screening'
  if (/johne/.test(d)) return "Johne's disease"
  return ''
}

// Constituent tests (col 21) are stored as a comma-separated string:
// "TC0401 : Antibiotic sensitivity, TC0186 : Coronavirus antigen"
// This splits them into an array of { code, name } objects for the template.
function parseConstituentTests (raw) {
  if (!raw) return []
  return raw.split(', ').map(entry => {
    const sep = entry.indexOf(' : ')
    if (sep === -1) return { code: entry.trim(), name: '' }
    return { code: entry.slice(0, sep).trim(), name: entry.slice(sep + 3).trim() }
  }).filter(t => t.code)
}

// -----------------------------------------------------------------------------
// Data load and cache
// Reads the full CSV once and caches the result. Only rows where Is Active
// (col 18) = TRUE are included — inactive tests are excluded from the prototype.
//
// CSV column reference (0-based index):
//   0  Test Code
//   4  Test Description
//   6  Test Type
//   7  Turn around time (working days)
//   8  PVS Price (£) — single test price, ex VAT
//  14  Species List
//  15  Price List Categories List
//  18  Is Active (TRUE / FALSE)
//  20  Package Notes
//  21  Constituent Tests List
//  22  UKAS Accred (Yes / No)
//  23  UKAS Accred Notes
//  25  Submission Instructions
//  26  Sample Type
//  27  Sample Quantity
//  28  Datasheet List
// -----------------------------------------------------------------------------
let priceListCache = null

function getPriceList () {
  if (priceListCache) return priceListCache

  const csvPath = path.join(__dirname, 'data', 'price-list.csv')
  // File uses Windows-1252 encoding; read as latin1 to preserve £ and other characters
  const text = fs.readFileSync(csvPath, 'latin1')
  const rows = parseCSV(text)

  // rows[0] is the header — skip it
  priceListCache = rows.slice(1).map(cols => {
    if ((cols[18] || '').trim().toUpperCase() !== 'TRUE') return null

    const code = (cols[0] || '').trim()
    const description = (cols[4] || '').trim()
    const testType = (cols[6] || '').trim()
    const turnaround = (cols[7] || '').trim()
    const price = (cols[8] || '').trim()
    const speciesList = (cols[14] || '').trim()
    const categories = (cols[15] || '').trim()
    const packageNotes = (cols[20] || '').trim()
    const constituentTests = parseConstituentTests((cols[21] || '').trim())
    const ukasAccred = (cols[22] || '').trim()
    const ukasNotes = (cols[23] || '').trim()
    const submissionInstructions = (cols[25] || '').trim()
    const sampleType = (cols[26] || '').trim()
    const sampleQuantity = (cols[27] || '').trim()
    const datasheets = (cols[28] || '').trim()

    const species = deriveSpecies(speciesList, categories)
    const age = deriveAge(description)
    const animal = [species, age].filter(Boolean).join(', ')
    const clinicalPurpose = deriveClinicalPurpose(description)

    return {
      code, description, testType, turnaround, price,
      species, age, animal, clinicalPurpose,
      sampleType, sampleQuantity, categories,
      packageNotes, constituentTests,
      ukasAccred, ukasNotes,
      submissionInstructions, datasheets
    }
  }).filter(Boolean)

  return priceListCache
}

// =============================================================================
// ROUTES
// =============================================================================

// / — main price list page (index.html), searchable and filterable
// Supports query params: search, species[], age[], type[]
router.get('/', (req, res) => {
  let tests = getPriceList()
  const { search, species, age, type } = req.query

  if (search) {
    const q = search.toLowerCase()
    tests = tests.filter(t =>
      t.code.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
    )
  }

  // The GOV.UK Prototype Kit sends '_unchecked' for unselected checkbox groups
  // to maintain session state. Filter these out before applying any filter.
  if (species) {
    const arr = [].concat(species).filter(s => s !== '_unchecked')
    if (arr.length) {
      tests = tests.filter(t =>
        arr.some(s => t.species.toLowerCase().includes(s.toLowerCase()))
      )
    }
  }

  if (age) {
    const arr = [].concat(age).filter(a => a !== '_unchecked')
    if (arr.length) {
      tests = tests.filter(t => arr.some(a => t.age.includes(a)))
    }
  }

  if (type) {
    const arr = [].concat(type).filter(tp => tp !== '_unchecked')
    if (arr.length) {
      tests = tests.filter(t =>
        arr.some(tp => t.testType.toLowerCase() === tp.toLowerCase())
      )
    }
  }

  res.render('index', { tests, query: req.query })
})

// /test-detail — individual test detail page, looked up by ?code=
router.get('/test-detail', (req, res) => {
  const test = getPriceList().find(t => t.code === req.query.code)
  if (!test) return res.status(404).send('Test not found')
  res.render('test-detail', { test })
})
