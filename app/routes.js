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
  // Split only on ', ' that is immediately followed by a test code pattern (e.g. TC0829, PC0059).
  // A plain split(', ') would break test names that contain commas (e.g. "K88, K99, 987P").
  return raw.split(/, (?=[A-Z]{2}\d{4} : )/).map(entry => {
    const sep = entry.indexOf(' : ')
    if (sep === -1) return null
    return { code: entry.slice(0, sep).trim(), name: entry.slice(sep + 3).trim() }
  }).filter(Boolean)
}

// -----------------------------------------------------------------------------
// Data load and cache
// Reads the full CSV once and caches the result. Only rows where Is Active
// (col 14) = TRUE are included — inactive tests are excluded from the prototype.
//
// CSV column reference (0-based index) — price-list-v2.csv:
//   0  Test Code
//   1  Test Description
//   2  Test Type
//   3  Max TRT (turnaround, working days)
//   4  PVS Price (£) — single test price, ex VAT
//   5  PVS Price 5+ (£)
//   6  PVS Price 10+ (£)
//   7  PVS Price Other (£)
//  10  Species List
//  11  Price List Categories List
//  14  Is Active (TRUE / empty)
//  16  Package Notes
//  17  Constituent Tests List
//  18  UKAS Accred (Yes / No)
//  19  UKAS Accred Notes
//  20  Diseases List        — not used in prototype
//  21  Notes (External Website)
//  22  Submission Instructions
//  23  Keywords             — not used in prototype
//  24  Sample Type
//  25  Sample Quantity
//  26  Datasheet List
//  27  Test Set-up Days
// -----------------------------------------------------------------------------
let priceListCache = null

function getPriceList () {
  if (priceListCache) return priceListCache

  const csvPath = path.join(__dirname, 'data', 'price-list-v2.csv')
  // File uses Windows-1252 encoding; read as latin1 to preserve £ and other characters
  const text = fs.readFileSync(csvPath, 'latin1')
  const rows = parseCSV(text)

  // rows[0] is the header — skip it
  priceListCache = rows.slice(1).map(cols => {
    if ((cols[14] || '').trim().toUpperCase() !== 'TRUE') return null

    const code = (cols[0] || '').trim()
    const description = (cols[1] || '').trim()
    const testType = (cols[2] || '').trim()
    const turnaround = (cols[3] || '').trim()
    const price = (cols[4] || '').trim()
    const price5plus = (cols[5] || '').trim()
    const price10plus = (cols[6] || '').trim()
    const priceOther = (cols[7] || '').trim()
    const speciesList = (cols[10] || '').trim()
    const categories = (cols[11] || '').trim()
    const packageNotes = (cols[16] || '').trim()
    const constituentTests = parseConstituentTests((cols[17] || '').trim())
    const ukasAccred = (cols[18] || '').trim()
    const ukasNotes = (cols[19] || '').trim()
    const notes = (cols[21] || '').trim()
    const submissionInstructions = (cols[22] || '').trim()
    const sampleType = (cols[24] || '').trim()
    const sampleQuantity = (cols[25] || '').trim()
    const datasheets = (cols[26] || '').trim()
    const testSetupDays = (cols[27] || '').trim()

    const species = deriveSpecies(speciesList, categories)
    const age = deriveAge(description)
    const animal = [species, age].filter(Boolean).join(', ')
    const clinicalPurpose = deriveClinicalPurpose(description)

    return {
      code, description, testType, turnaround, price, price5plus, price10plus, priceOther,
      species, age, animal, clinicalPurpose,
      sampleType, sampleQuantity, categories,
      packageNotes, constituentTests,
      ukasAccred, ukasNotes,
      notes, submissionInstructions, datasheets, testSetupDays
    }
  }).filter(Boolean)

  return priceListCache
}

// =============================================================================
// ROUTES — helpers
// =============================================================================

// Human-readable labels for filter values used in the "selected filters" tags
const speciesLabels = { Cattle: 'Cattle', Sheep: 'Sheep / Goat', Pig: 'Pig', Equine: 'Equine', Birds: 'Avian', Camelid: 'Camelid' }
const typeLabels = { Package: 'Package', ELISA: 'ELISA', Histopathology: 'Histopathology', PME: 'Post mortem', 'RSA Package': 'RSA Package' }

// Builds a /?key=val&... URL from a query object, stripping _unchecked sentinels
function buildUrl (params) {
  const parts = []
  for (const [key, val] of Object.entries(params)) {
    for (const v of [].concat(val)) {
      if (v && v !== '_unchecked') {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`)
      }
    }
  }
  return parts.length ? `/?${parts.join('&')}` : '/'
}

// Returns a URL with one specific filter value removed from the current query
function removeFilterUrl (query, key, valueToRemove) {
  const updated = {}
  for (const [k, v] of Object.entries(query)) {
    if (k === key) {
      if (valueToRemove === undefined) continue // remove entire key
      const remaining = [].concat(v).filter(i => i !== '_unchecked' && i !== valueToRemove)
      if (remaining.length) updated[k] = remaining
    } else {
      updated[k] = v
    }
  }
  return buildUrl(updated)
}

// Builds the selectedFilters array passed to the template for tag display
function buildSelectedFilters (query) {
  const { search, species, age, type } = query
  const groups = []

  if (search && search.trim()) {
    groups.push({
      category: 'Search',
      items: [{ label: search.trim(), removeUrl: removeFilterUrl(query, 'search') }]
    })
  }

  const activeSpecies = species ? [].concat(species).filter(s => s !== '_unchecked') : []
  if (activeSpecies.length) {
    groups.push({
      category: 'Species',
      items: activeSpecies.map(s => ({
        label: speciesLabels[s] || s,
        removeUrl: removeFilterUrl(query, 'species', s)
      }))
    })
  }

  const activeAge = age ? [].concat(age).filter(a => a !== '_unchecked') : []
  if (activeAge.length) {
    groups.push({
      category: 'Age group',
      items: activeAge.map(a => ({
        label: a,
        removeUrl: removeFilterUrl(query, 'age', a)
      }))
    })
  }

  const activeType = type ? [].concat(type).filter(t => t !== '_unchecked') : []
  if (activeType.length) {
    groups.push({
      category: 'Test type',
      items: activeType.map(t => ({
        label: typeLabels[t] || t,
        removeUrl: removeFilterUrl(query, 'type', t)
      }))
    })
  }

  return groups
}

// =============================================================================
// ROUTES
// =============================================================================

// / — main price list page (index.html), searchable and filterable
// Supports query params: search, species[], age[], type[]
router.get('/', (req, res) => {
  const allTests = getPriceList()
  let tests = allTests
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

  res.render('index', {
    tests,
    totalTests: allTests.length,
    query: req.query,
    selectedFilters: buildSelectedFilters(req.query)
  })
})

// /test-detail — individual test detail page, looked up by ?code=
router.get('/test-detail', (req, res) => {
  const test = getPriceList().find(t => t.code === req.query.code)
  if (!test) return res.status(404).send('Test not found')
  res.render('test-detail', { test })
})
