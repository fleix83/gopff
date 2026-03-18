import { neon } from 'https://esm.sh/@neondatabase/serverless'

const sql = neon('postgresql://neondb_owner:npg_o0Nw5cTxEUFa@ep-old-grass-ale8zfkm-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require')

// ---- PASSWORT-HASHING (Web Crypto API) ----

async function generateSalt() {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('')
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  )
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('')
}

function debounce(fn, delay) {
  let timer = null
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay) }
}

// ---- IMAGE UPLOAD ----
const WORKER_URL = 'https://goppf-upload.felixschmid.workers.dev'

async function resizeImage(file, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let w = img.width, h = img.height
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality)
    }
    img.src = URL.createObjectURL(file)
  })
}

async function uploadImage(file) {
  const blob = await resizeImage(file)
  const fd = new FormData()
  fd.append('file', blob, 'image.jpg')
  const res = await fetch(WORKER_URL + '/upload', { method: 'POST', body: fd })
  if (!res.ok) throw new Error('Upload fehlgeschlagen')
  const data = await res.json()
  return data.url
}

async function deleteImage(url) {
  const key = url.split('/').slice(-2).join('/')
  await fetch(WORKER_URL + '/delete?key=' + encodeURIComponent(key), { method: 'DELETE' })
}

const { createApp, ref, computed, watch, onMounted } = Vue

createApp({
  setup() {
    const view = ref('home')
    const filterKategorie = ref('')
    const kommentarText = ref('')
    const aktiverBeitragId = ref(null)
    const menuOpen = ref(false)
    const neueKategorie = ref('')
    const editKategorieIndex = ref(-1)
    const editKategorieName = ref('')
    const kommentarFormOpen = ref(false)
    const loading = ref(false)
    const formNoteAccepted = ref(false)

    // Image upload
    const imageFile = ref(null)
    const imagePreview = ref(null)
    const imageUploading = ref(false)

    // Auth
    const currentUser = ref(null)
    const showAuthModal = ref(false)
    const authMode = ref('login') // 'login' oder 'signup'
    const authForm = ref({ name: '', email: '', password: '' })
    const authError = ref('')
    const authLoading = ref(false)

    // Modals
    const showCompanyModal = ref(false)
    const showProductModal = ref(false)
    const companyForm = ref({ name: '', municipality: '', canton: '' })
    const productForm = ref({ name: '', model: '' })
    const gemeindeSearch = ref('')
    const gemeindeFocused = ref(false)

    // DB data
    const kategorien = ref([])
    const companies = ref([])
    const products = ref([])
    const beitraege = ref([])
    const aktiverBeitrag = ref(null)

    const kantone = [
      'Aargau', 'Appenzell Ausserrhoden', 'Appenzell Innerrhoden',
      'Basel-Landschaft', 'Basel-Stadt', 'Bern', 'Freiburg', 'Genf',
      'Glarus', 'Graubünden', 'Jura', 'Luzern', 'Neuenburg', 'Nidwalden',
      'Obwalden', 'Schaffhausen', 'Schwyz', 'Solothurn', 'St. Gallen',
      'Tessin', 'Thurgau', 'Uri', 'Waadt', 'Wallis', 'Zug', 'Zürich'
    ]

    const kantonKuerzel = {
      'Aargau': 'AG', 'Appenzell Ausserrhoden': 'AR', 'Appenzell Innerrhoden': 'AI',
      'Basel-Landschaft': 'BL', 'Basel-Stadt': 'BS', 'Bern': 'BE', 'Freiburg': 'FR',
      'Genf': 'GE', 'Glarus': 'GL', 'Graubünden': 'GR', 'Jura': 'JU', 'Luzern': 'LU',
      'Neuenburg': 'NE', 'Nidwalden': 'NW', 'Obwalden': 'OW', 'Schaffhausen': 'SH',
      'Schwyz': 'SZ', 'Solothurn': 'SO', 'St. Gallen': 'SG', 'Tessin': 'TI',
      'Thurgau': 'TG', 'Uri': 'UR', 'Waadt': 'VD', 'Wallis': 'VS', 'Zug': 'ZG', 'Zürich': 'ZH'
    }

    const kuerzelKanton = Object.fromEntries(Object.entries(kantonKuerzel).map(([k, v]) => [v, k]))

    // Gemeinden werden via OpenPLZ API geladen
    const gemeinden = ref([])

    const gefilterteGemeinden = computed(() => {
      const q = gemeindeSearch.value.trim().toLowerCase()
      if (!q) return []
      return gemeinden.value.filter(g =>
        g.name.toLowerCase().includes(q) || g.kt.toLowerCase().includes(q)
      ).slice(0, 15)
    })

    async function ladeGemeinden() {
      // Cache prüfen (7 Tage gültig)
      try {
        const cached = localStorage.getItem('gemeinden_cache')
        if (cached) {
          const { data, timestamp } = JSON.parse(cached)
          if (Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000) {
            gemeinden.value = data
            return
          }
        }
      } catch (e) { /* Cache-Fehler ignorieren */ }

      try {
        // Alle Gemeinden eines Kantons laden (paginiert, max 50 pro Seite)
        async function fetchKanton(key) {
          let alle = []
          let page = 1
          while (true) {
            const res = await fetch(`https://openplzapi.org/ch/Cantons/${key}/Communes?page=${page}&pageSize=50`)
            const data = await res.json()
            alle = alle.concat(data)
            if (data.length < 50) break
            page++
          }
          return alle
        }

        const kantonKeys = Array.from({ length: 26 }, (_, i) => i + 1)
        const results = await Promise.all(kantonKeys.map(k => fetchKanton(k)))
        const alle = results.flat().map(g => ({
          name: g.name,
          kt: g.canton.shortName
        }))
        alle.sort((a, b) => a.name.localeCompare(b.name, 'de'))
        gemeinden.value = alle

        // Im localStorage cachen
        try {
          localStorage.setItem('gemeinden_cache', JSON.stringify({ data: alle, timestamp: Date.now() }))
        } catch (e) { /* Storage voll — ignorieren */ }
      } catch (e) {
        console.error('Gemeinden laden fehlgeschlagen:', e)
      }
    }

    // Form
    const form = ref({
      kategorie_id: '',
      company_id: '',
      product_id: '',
      kanton: '',
      text: ''
    })

    // Company search
    const companySearch = ref('')
    const companyFocused = ref(false)
    const companySearchResults = ref([])
    const companySearchLoading = ref(false)
    const selectedCompanyObj = ref(null)

    // Admin company search
    const firmenSearchResults = ref([])
    const firmenSearchLoading = ref(false)

    // Edit post company search
    const editBeitragCompanyResults = ref([])
    const editBeitragCompanyLoading = ref(false)

    // Product search
    const productSearch = ref('')
    const productFocused = ref(false)

    async function searchCompanies(query, targetResults, targetLoading) {
      const q = query.trim()
      if (q.length < 2) {
        targetResults.value = []
        return
      }
      targetLoading.value = true
      try {
        const rows = await sql`
          SELECT id, name, municipality, canton
          FROM company
          WHERE name ILIKE ${'%' + q + '%'}
          ORDER BY
            (name ILIKE ${q + '%'}) DESC,
            length(name) ASC
          LIMIT 15
        `
        targetResults.value = rows
      } catch (e) {
        console.error('Company search error:', e)
        targetResults.value = []
      }
      targetLoading.value = false
    }

    const debouncedCompanySearch = debounce((val) => searchCompanies(val, companySearchResults, companySearchLoading), 300)
    const debouncedFirmenSearch = debounce((val) => searchCompanies(val, firmenSearchResults, firmenSearchLoading), 300)
    const debouncedEditBeitragCompanySearch = debounce((val) => searchCompanies(val, editBeitragCompanyResults, editBeitragCompanyLoading), 300)

    watch(companySearch, (val) => { if (!form.value.company_id) debouncedCompanySearch(val) })

    const gefilterteCompanies = computed(() => companySearchResults.value)

    const gefilterteProducts = computed(() => {
      if (!form.value.company_id) return []
      let list = products.value.filter(p => p.company_id === form.value.company_id)
      const q = productSearch.value.trim().toLowerCase()
      if (q) {
        list = list.filter(p => p.name.toLowerCase().includes(q))
      }
      return list
    })

    const selectedCompanyName = computed(() => {
      return selectedCompanyObj.value ? selectedCompanyObj.value.name : ''
    })

    const selectedProductName = computed(() => {
      const p = products.value.find(p => p.id === form.value.product_id)
      return p ? p.name : ''
    })

    // Watch kategorie change → reset company + product
    watch(() => form.value.kategorie_id, () => {
      form.value.company_id = ''
      form.value.product_id = ''
      companySearch.value = ''
      productSearch.value = ''
    })

    // Watch company change → reset product, load products
    watch(() => form.value.company_id, async (newId) => {
      form.value.product_id = ''
      productSearch.value = ''
      if (newId) {
        await ladeProducts()
      }
    })

    // ---- AUTH ----

    function checkSession() {
      try {
        const stored = localStorage.getItem('goppf_user')
        if (stored) {
          currentUser.value = JSON.parse(stored)
        } else {
          currentUser.value = null
        }
      } catch (e) {
        currentUser.value = null
      }
    }

    function openAuth(mode) {
      authMode.value = mode
      authForm.value = { name: '', email: '', password: '' }
      authError.value = ''
      showAuthModal.value = true
    }

    async function authSubmit() {
      authError.value = ''
      authLoading.value = true
      try {
        if (authMode.value === 'signup') {
          const name = authForm.value.name.trim()
          const email = authForm.value.email.trim().toLowerCase()
          const password = authForm.value.password
          if (!name || !email || !password) {
            authError.value = 'Bitte alle Felder ausfüllen'
            authLoading.value = false
            return
          }
          if (password.length < 6) {
            authError.value = 'Passwort muss mindestens 6 Zeichen haben'
            authLoading.value = false
            return
          }
          // Prüfen ob E-Mail schon existiert
          const existing = await sql`SELECT id FROM app_user WHERE email = ${email}`
          if (existing.length > 0) {
            authError.value = 'Diese E-Mail-Adresse ist bereits registriert'
            authLoading.value = false
            return
          }
          const salt = await generateSalt()
          const password_hash = await hashPassword(password, salt)
          const rows = await sql`
            INSERT INTO app_user (name, email, password_hash, salt)
            VALUES (${name}, ${email}, ${password_hash}, ${salt})
            RETURNING id, name, email, role
          `
          const user = rows[0]
          currentUser.value = user
          localStorage.setItem('goppf_user', JSON.stringify(user))
        } else {
          const email = authForm.value.email.trim().toLowerCase()
          const password = authForm.value.password
          if (!email || !password) {
            authError.value = 'Bitte E-Mail und Passwort eingeben'
            authLoading.value = false
            return
          }
          const rows = await sql`SELECT id, name, email, role, password_hash, salt FROM app_user WHERE email = ${email}`
          if (rows.length === 0) {
            authError.value = 'E-Mail oder Passwort falsch'
            authLoading.value = false
            return
          }
          const user = rows[0]
          const check = await hashPassword(password, user.salt)
          if (check !== user.password_hash) {
            authError.value = 'E-Mail oder Passwort falsch'
            authLoading.value = false
            return
          }
          const sessionUser = { id: user.id, name: user.name, email: user.email, role: user.role }
          currentUser.value = sessionUser
          localStorage.setItem('goppf_user', JSON.stringify(sessionUser))
        }
        showAuthModal.value = false
      } catch (e) {
        console.error('Auth-Fehler:', e)
        authError.value = 'Fehler – bitte nochmals versuchen'
      }
      authLoading.value = false
    }

    function logout() {
      localStorage.removeItem('goppf_user')
      currentUser.value = null
      menuOpen.value = false
    }

    // ---- DATA LOADING ----

    async function ladeKategorien() {
      const rows = await sql`SELECT id, name FROM category ORDER BY sort_order`
      kategorien.value = rows
    }

    async function ladeCompanies() {
      const rows = await sql`SELECT id, name, municipality, canton, website FROM company ORDER BY name`
      companies.value = rows
    }

    async function ladeProducts() {
      const rows = await sql`SELECT id, name, type, company_id FROM product ORDER BY name`
      products.value = rows
    }

    async function ladeBeitraege() {
      const rows = await sql`
        SELECT p.id, p.content, p.canton, p.created_at, p.flagged,
               p.company_id, p.product_id, p.image_url,
               c.name as company_name,
               c.municipality as company_municipality, c.canton as company_canton,
               pr.name as product_name,
               u.name as user_name,
               (SELECT count(*) FROM comment cm WHERE cm.post_id = p.id) as comment_count,
               (SELECT array_agg(cc.category_id) FROM company_category cc WHERE cc.company_id = c.id) as category_ids,
               (SELECT string_agg(cat.name, ', ' ORDER BY cat.sort_order) FROM company_category cc JOIN category cat ON cat.id = cc.category_id WHERE cc.company_id = c.id) as category_name
        FROM post p
        JOIN company c ON c.id = p.company_id
        LEFT JOIN product pr ON pr.id = p.product_id
        LEFT JOIN app_user u ON u.id = p.user_id
        ORDER BY p.created_at DESC
      `
      beitraege.value = rows
    }

    async function ladeKommentare(postId) {
      return await sql`
        SELECT cm.id, cm.content, cm.created_at,
               u.name as user_name
        FROM comment cm
        LEFT JOIN app_user u ON u.id = cm.user_id
        WHERE cm.post_id = ${postId}
        ORDER BY cm.created_at ASC
      `
    }

    async function ladeBeitragDetail(id) {
      const rows = await sql`
        SELECT p.id, p.content, p.canton, p.created_at, p.image_url,
               c.name as company_name, c.id as company_id,
               c.municipality as company_municipality, c.canton as company_canton,
               pr.name as product_name,
               u.name as user_name,
               (SELECT array_agg(cc.category_id) FROM company_category cc WHERE cc.company_id = c.id) as category_ids,
               (SELECT string_agg(cat.name, ', ' ORDER BY cat.sort_order) FROM company_category cc JOIN category cat ON cat.id = cc.category_id WHERE cc.company_id = c.id) as category_name
        FROM post p
        JOIN company c ON c.id = p.company_id
        LEFT JOIN product pr ON pr.id = p.product_id
        LEFT JOIN app_user u ON u.id = p.user_id
        WHERE p.id = ${id}
      `
      if (rows.length === 0) return
      const kommentare = await ladeKommentare(id)
      aktiverBeitrag.value = { ...rows[0], kommentare }
    }

    // ---- FILTER ----

    function toggleFilter(cat) {
      filterKategorie.value = filterKategorie.value === cat.id ? '' : cat.id
    }

    const gefilterteBeitraege = computed(() => {
      if (!filterKategorie.value) return beitraege.value
      return beitraege.value.filter(b => b.category_ids && b.category_ids.includes(filterKategorie.value))
    })

    const filterKategorieName = computed(() => {
      const cat = kategorien.value.find(c => c.id === filterKategorie.value)
      return cat ? cat.name : ''
    })

    function ortAnzeige(item) {
      if (item.company_municipality && item.company_canton) {
        const kuerzel = kantonKuerzel[item.company_canton]
        return item.company_municipality + (kuerzel ? ' ' + kuerzel : '')
      }
      if (item.company_canton) {
        const kuerzel = kantonKuerzel[item.company_canton]
        return kuerzel || item.company_canton
      }
      return 'Schweiz'
    }

    // ---- NAVIGATION ----

    const showFormNote = computed(() => view.value === 'new' && !formNoteAccepted.value)

    function navigate(target) {
      view.value = target
      menuOpen.value = false
      if (target === 'home') {
        aktiverBeitragId.value = null
        aktiverBeitrag.value = null
      }
      window.scrollTo(0, 0)
    }

    async function openBeitrag(id) {
      aktiverBeitragId.value = id
      kommentarFormOpen.value = false
      kommentarText.value = ''
      view.value = 'detail'
      loading.value = true
      await ladeBeitragDetail(id)
      loading.value = false
      window.scrollTo(0, 0)
    }

    function delayedBlur(fn) {
      setTimeout(() => fn(), 200)
    }

    // ---- COMPANY SELECTION ----

    function selectCompany(company) {
      form.value.company_id = company.id
      selectedCompanyObj.value = company
      companySearch.value = company.name
      companyFocused.value = false
    }

    function clearCompany() {
      form.value.company_id = ''
      form.value.product_id = ''
      selectedCompanyObj.value = null
      companySearch.value = ''
      productSearch.value = ''
      companySearchResults.value = []
    }

    function selectProduct(product) {
      form.value.product_id = product.id
      productSearch.value = product.name
      productFocused.value = false
    }

    function clearProduct() {
      form.value.product_id = ''
      productSearch.value = ''
    }

    // ---- COMPANY / PRODUCT ERSTELLEN ----

    function openCompanyModal() {
      companyForm.value = { name: '', municipality: '', canton: '' }
      gemeindeSearch.value = ''
      showCompanyModal.value = true
      companyFocused.value = false
    }

    function selectGemeinde(g) {
      companyForm.value.municipality = g.name
      companyForm.value.canton = kuerzelKanton[g.kt]
      gemeindeSearch.value = `${g.name} ${g.kt}`
      gemeindeFocused.value = false
    }

    async function companyErstellen() {
      const name = companyForm.value.name.trim()
      if (!name) return
      loading.value = true
      const catId = form.value.kategorie_id || null
      const municipality = companyForm.value.municipality || gemeindeSearch.value.trim() || null
      const canton = companyForm.value.canton || null
      try {
        const rows = await sql`
          INSERT INTO company (name, municipality, canton)
          VALUES (${name}, ${municipality}, ${canton})
          RETURNING id, name, municipality, canton
        `
        if (rows.length > 0 && catId) {
          await sql`INSERT INTO company_category (company_id, category_id) VALUES (${rows[0].id}, ${catId}) ON CONFLICT DO NOTHING`
        }
        showCompanyModal.value = false
        if (rows.length > 0) {
          selectCompany(rows[0])
        }
      } catch (e) {
        if (e.message && e.message.includes('duplicate')) {
          const found = await sql`SELECT id, name, municipality, canton FROM company WHERE lower(name) = ${name.toLowerCase()} AND municipality IS NOT DISTINCT FROM ${municipality} AND canton IS NOT DISTINCT FROM ${canton} LIMIT 1`
          if (found.length > 0) {
            selectCompany(found[0])
          }
          showCompanyModal.value = false
        } else {
          alert('Fehler beim Erstellen: ' + e.message)
        }
      }
      loading.value = false
    }

    function openProductModal() {
      productForm.value = { name: '', model: '' }
      showProductModal.value = true
    }

    async function productErstellen() {
      const name = productForm.value.name.trim()
      if (!name || !form.value.company_id) return
      loading.value = true
      const model = productForm.value.model.trim() || null
      const rows = await sql`
        INSERT INTO product (company_id, name, model)
        VALUES (${form.value.company_id}, ${name}, ${model})
        RETURNING id, name, company_id
      `
      showProductModal.value = false
      await ladeProducts()
      if (rows.length > 0) {
        form.value.product_id = rows[0].id
        productSearch.value = rows[0].name
      }
      loading.value = false
    }

    // ---- IMAGE HANDLERS ----

    function onImageSelect(event) {
      const file = event.target.files[0]
      if (!file) return
      const allowed = ['image/jpeg', 'image/png', 'image/webp']
      if (!allowed.includes(file.type)) {
        alert('Nur JPG, PNG oder WebP erlaubt.')
        event.target.value = ''
        return
      }
      if (file.size > 10 * 1024 * 1024) {
        alert('Bild darf max. 10 MB gross sein.')
        event.target.value = ''
        return
      }
      imageFile.value = file
      imagePreview.value = URL.createObjectURL(file)
    }

    function clearImage() {
      imageFile.value = null
      if (imagePreview.value) { URL.revokeObjectURL(imagePreview.value) }
      imagePreview.value = null
    }

    // ---- BEITRAG ERSTELLEN ----

    async function beitragErstellen() {
      if (!form.value.company_id || !form.value.kanton || !form.value.text.trim()) return
      if (!currentUser.value) { openAuth('login'); return }
      loading.value = true
      let imageUrl = null
      if (imageFile.value) {
        try {
          imageUploading.value = true
          imageUrl = await uploadImage(imageFile.value)
        } catch (e) {
          alert('Bild-Upload fehlgeschlagen: ' + e.message)
          imageUploading.value = false
          loading.value = false
          return
        }
        imageUploading.value = false
      }
      const productId = form.value.product_id || null
      const userId = currentUser.value.id
      await sql`
        INSERT INTO post (company_id, product_id, canton, content, user_id, image_url)
        VALUES (${form.value.company_id}, ${productId}, ${form.value.kanton}, ${form.value.text.trim()}, ${userId}, ${imageUrl})
      `
      form.value = { kategorie_id: '', company_id: '', product_id: '', kanton: '', text: '' }
      selectedCompanyObj.value = null
      companySearch.value = ''
      productSearch.value = ''
      clearImage()
      await ladeBeitraege()
      loading.value = false
      navigate('home')
    }

    // ---- KOMMENTAR ----

    async function kommentarErstellen() {
      if (!kommentarText.value.trim() || !aktiverBeitragId.value) return
      if (!currentUser.value) { openAuth('login'); return }
      loading.value = true
      const userId = currentUser.value.id
      await sql`
        INSERT INTO comment (post_id, content, user_id)
        VALUES (${aktiverBeitragId.value}, ${kommentarText.value.trim()}, ${userId})
      `
      kommentarText.value = ''
      kommentarFormOpen.value = false
      await Promise.all([ladeBeitragDetail(aktiverBeitragId.value), ladeBeitraege()])
      loading.value = false
    }

    // ---- KATEGORIEN VERWALTEN ----

    async function kategorieHinzufuegen() {
      const name = neueKategorie.value.trim()
      if (!name) return
      const maxOrder = await sql`SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM category`
      await sql`INSERT INTO category (name, sort_order) VALUES (${name}, ${maxOrder[0].next})`
      neueKategorie.value = ''
      await ladeKategorien()
    }

    async function kategorieLoeschen(cat) {
      await sql`DELETE FROM category WHERE id = ${cat.id}`
      await ladeKategorien()
    }

    function kategorieBearbeiten(index) {
      editKategorieIndex.value = index
      editKategorieName.value = kategorien.value[index].name
    }

    async function kategorieSpeichernEdit(index) {
      const name = editKategorieName.value.trim()
      if (!name) return
      try {
        const cat = kategorien.value[index]
        await sql`UPDATE category SET name = ${name} WHERE id = ${cat.id}`
        editKategorieIndex.value = -1
        await Promise.all([ladeKategorien(), ladeBeitraege()])
      } catch (e) {
        alert('Fehler beim Speichern: ' + e.message)
      }
    }

    // ---- FIRMEN VERWALTEN ----

    const firmenSuche = ref('')
    const editFirmaId = ref(null)
    const editFirmaForm = ref({ name: '', municipality: '', canton: '', category_ids: [] })
    const editFirmaGemeindeSearch = ref('')
    const editFirmaGemeindeFocused = ref(false)
    const firmaProduktId = ref(null)
    const editProduktId = ref(null)
    const editProduktForm = ref({ name: '', model: '' })
    const neuesProduktName = ref('')

    watch(firmenSuche, (val) => { debouncedFirmenSearch(val) })

    const gefilterteFirmen = computed(() => {
      const q = firmenSuche.value.trim()
      if (q.length < 2) return []
      return firmenSearchResults.value
    })

    const firmaProduktListe = computed(() => {
      if (!firmaProduktId.value) return []
      return products.value.filter(p => p.company_id === firmaProduktId.value)
    })

    const editFirmaGefilterteGemeinden = computed(() => {
      const q = editFirmaGemeindeSearch.value.trim().toLowerCase()
      if (!q) return []
      return gemeinden.value.filter(g =>
        g.name.toLowerCase().includes(q) || g.kt.toLowerCase().includes(q)
      ).slice(0, 15)
    })

    async function firmaBearbeiten(comp) {
      editFirmaId.value = comp.id
      const cats = await sql`SELECT category_id FROM company_category WHERE company_id = ${comp.id}`
      editFirmaForm.value = {
        name: comp.name,
        municipality: comp.municipality || '',
        canton: comp.canton || '',
        category_ids: cats.map(c => c.category_id)
      }
      const kuerzel = comp.canton ? kantonKuerzel[comp.canton] : ''
      editFirmaGemeindeSearch.value = comp.municipality ? comp.municipality + (kuerzel ? ' ' + kuerzel : '') : ''
    }

    function editFirmaSelectGemeinde(g) {
      editFirmaForm.value.municipality = g.name
      editFirmaForm.value.canton = kuerzelKanton[g.kt]
      editFirmaGemeindeSearch.value = `${g.name} ${g.kt}`
      editFirmaGemeindeFocused.value = false
    }

    async function firmaSpeichern(id) {
      const name = editFirmaForm.value.name.trim()
      if (!name) return
      loading.value = true
      try {
        const municipality = editFirmaForm.value.municipality || null
        const canton = editFirmaForm.value.canton || null
        const categoryIds = editFirmaForm.value.category_ids || []
        await sql`
          UPDATE company SET name = ${name}, municipality = ${municipality}, canton = ${canton}
          WHERE id = ${id}
        `
        await sql`DELETE FROM company_category WHERE company_id = ${id}`
        for (const catId of categoryIds) {
          await sql`INSERT INTO company_category (company_id, category_id) VALUES (${id}, ${catId}) ON CONFLICT DO NOTHING`
        }
        editFirmaId.value = null
        // Refresh the current admin search results + posts
        if (firmenSuche.value.trim().length >= 2) {
          await Promise.all([searchCompanies(firmenSuche.value, firmenSearchResults, firmenSearchLoading), ladeBeitraege()])
        } else {
          await ladeBeitraege()
        }
      } catch (e) {
        alert('Fehler beim Speichern: ' + e.message)
      }
      loading.value = false
    }

    async function firmaLoeschen(comp) {
      loading.value = true
      try {
        await sql`DELETE FROM product WHERE company_id = ${comp.id}`
        await sql`DELETE FROM company WHERE id = ${comp.id}`
        firmenSearchResults.value = firmenSearchResults.value.filter(c => c.id !== comp.id)
        await Promise.all([ladeProducts(), ladeBeitraege()])
      } catch (e) {
        alert('Firma kann nicht gelöscht werden: ' + e.message)
      }
      loading.value = false
    }

    function firmaProdukte(comp) {
      firmaProduktId.value = firmaProduktId.value === comp.id ? null : comp.id
      editProduktId.value = null
      neuesProduktName.value = ''
    }

    function produktBearbeiten(prod) {
      editProduktId.value = prod.id
      editProduktForm.value = { name: prod.name, model: prod.model || '' }
    }

    async function produktSpeichern(id) {
      const name = editProduktForm.value.name.trim()
      if (!name) return
      loading.value = true
      try {
        const model = editProduktForm.value.model.trim() || null
        await sql`UPDATE product SET name = ${name}, model = ${model} WHERE id = ${id}`
        editProduktId.value = null
        await ladeProducts()
      } catch (e) {
        alert('Fehler beim Speichern: ' + e.message)
      }
      loading.value = false
    }

    async function produktLoeschen(prod) {
      loading.value = true
      try {
        await sql`DELETE FROM product WHERE id = ${prod.id}`
        await ladeProducts()
      } catch (e) {
        alert('Produkt kann nicht gelöscht werden: ' + e.message)
      }
      loading.value = false
    }

    async function produktHinzufuegen(companyId) {
      const name = neuesProduktName.value.trim()
      if (!name) return
      loading.value = true
      await sql`INSERT INTO product (company_id, name, type) VALUES (${companyId}, ${name}, 'product')`
      neuesProduktName.value = ''
      await ladeProducts()
      loading.value = false
    }

    // ---- BEITRÄGE VERWALTEN ----

    const beitragSuche = ref('')
    const beitragFilter = ref('alle')
    const editBeitragId = ref(null)
    const editBeitragForm = ref({ company_id: '', product_id: '', canton: '', content: '' })
    const editBeitragImageUrl = ref(null)
    const editBeitragCompanySearch = ref('')
    const editBeitragCompanyFocused = ref(false)
    const beitragKommentare = ref([])
    const editKommentarId = ref(null)
    const editKommentarText = ref('')

    const gefilterteBeitraegeAdmin = computed(() => {
      let list = beitraege.value
      if (beitragFilter.value === 'flagged') {
        list = list.filter(b => b.flagged)
      }
      const q = beitragSuche.value.trim().toLowerCase()
      if (q) {
        list = list.filter(b =>
          b.company_name.toLowerCase().includes(q) ||
          b.content.toLowerCase().includes(q) ||
          (b.product_name && b.product_name.toLowerCase().includes(q))
        )
      }
      return list
    })

    watch(editBeitragCompanySearch, (val) => { if (!editBeitragForm.value.company_id) debouncedEditBeitragCompanySearch(val) })

    const editBeitragGefilterteCompanies = computed(() => editBeitragCompanyResults.value)

    const editBeitragSelectedObj = ref(null)
    const editBeitragCompanyName = computed(() => {
      return editBeitragSelectedObj.value ? editBeitragSelectedObj.value.name : ''
    })

    const editBeitragProdukte = computed(() => {
      if (!editBeitragForm.value.company_id) return []
      return products.value.filter(p => p.company_id === editBeitragForm.value.company_id)
    })

    async function beitragBearbeiten(post) {
      if (editBeitragId.value === post.id) {
        editBeitragId.value = null
        return
      }
      editBeitragId.value = post.id
      editBeitragForm.value = {
        company_id: post.company_id,
        product_id: post.product_id || '',
        canton: post.canton,
        content: post.content
      }
      editBeitragImageUrl.value = post.image_url || null
      editBeitragSelectedObj.value = { id: post.company_id, name: post.company_name }
      editBeitragCompanySearch.value = post.company_name
      editKommentarId.value = null
      beitragKommentare.value = await ladeKommentare(post.id)
    }

    async function removeEditBeitragImage(postId) {
      loading.value = true
      try {
        if (editBeitragImageUrl.value) {
          await deleteImage(editBeitragImageUrl.value)
        }
        await sql`UPDATE post SET image_url = NULL WHERE id = ${postId}`
        editBeitragImageUrl.value = null
        await ladeBeitraege()
      } catch (e) {
        alert('Fehler beim Entfernen des Bildes: ' + e.message)
      }
      loading.value = false
    }

    async function beitragSpeichern(id) {
      const f = editBeitragForm.value
      if (!f.company_id || !f.canton || !f.content.trim()) return
      loading.value = true
      try {
        const productId = f.product_id || null
        await sql`
          UPDATE post SET company_id = ${f.company_id}, product_id = ${productId}, canton = ${f.canton}, content = ${f.content.trim()}
          WHERE id = ${id}
        `
        editBeitragId.value = null
        await ladeBeitraege()
      } catch (e) {
        alert('Fehler beim Speichern: ' + e.message)
      }
      loading.value = false
    }

    async function beitragLoeschen(post) {
      loading.value = true
      try {
        if (post.image_url) {
          try { await deleteImage(post.image_url) } catch (e) { /* ignore R2 error */ }
        }
        await sql`DELETE FROM comment WHERE post_id = ${post.id}`
        await sql`DELETE FROM post WHERE id = ${post.id}`
        editBeitragId.value = null
        await ladeBeitraege()
      } catch (e) {
        alert('Fehler beim Löschen: ' + e.message)
      }
      loading.value = false
    }

    async function beitragFlag(post) {
      loading.value = true
      const newFlag = !post.flagged
      await sql`UPDATE post SET flagged = ${newFlag} WHERE id = ${post.id}`
      await ladeBeitraege()
      loading.value = false
    }

    function kommentarBearbeitenAdmin(km) {
      editKommentarId.value = km.id
      editKommentarText.value = km.content
    }

    async function kommentarSpeichernAdmin(id) {
      const text = editKommentarText.value.trim()
      if (!text) return
      loading.value = true
      try {
        await sql`UPDATE comment SET content = ${text} WHERE id = ${id}`
        editKommentarId.value = null
        beitragKommentare.value = await ladeKommentare(editBeitragId.value)
      } catch (e) {
        alert('Fehler beim Speichern: ' + e.message)
      }
      loading.value = false
    }

    async function kommentarLoeschenAdmin(km) {
      loading.value = true
      await sql`DELETE FROM comment WHERE id = ${km.id}`
      beitragKommentare.value = beitragKommentare.value.filter(k => k.id !== km.id)
      await ladeBeitraege()
      loading.value = false
    }

    // ---- DATUM ----

    function formatDatum(timestamp) {
      const d = new Date(timestamp)
      return d.toLocaleDateString('de-CH', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })
    }

    // ---- INIT ----

    onMounted(async () => {
      loading.value = true
      await Promise.all([ladeKategorien(), ladeProducts(), ladeBeitraege(), checkSession()])
      loading.value = false
      // Gemeinden im Hintergrund laden (nicht blockierend)
      ladeGemeinden()
    })

    return {
      view, filterKategorie, filterKategorieName, kommentarText, form,
      kategorien, kantone, beitraege, gefilterteBeitraege,
      aktiverBeitrag, aktiverBeitragId,
      menuOpen, neueKategorie, editKategorieIndex, editKategorieName,
      kommentarFormOpen, loading, formNoteAccepted, showFormNote,
      companies, products, gefilterteCompanies, gefilterteProducts,
      companySearch, companyFocused, selectedCompanyName,
      companySearchLoading, firmenSearchLoading, editBeitragCompanyLoading,
      productSearch, productFocused, selectedProductName,
      showCompanyModal, showProductModal, companyForm, productForm,
      gemeindeSearch, gemeindeFocused, gefilterteGemeinden,
      currentUser, showAuthModal, authMode, authForm, authError, authLoading,
      delayedBlur, navigate, toggleFilter, openBeitrag,
      selectCompany, clearCompany,
      selectProduct, clearProduct,
      openCompanyModal, companyErstellen, selectGemeinde,
      openProductModal, productErstellen,
      beitragErstellen, kommentarErstellen, formatDatum, ortAnzeige,
      kategorieHinzufuegen, kategorieLoeschen,
      kategorieBearbeiten, kategorieSpeichernEdit,
      firmenSuche, gefilterteFirmen, editFirmaId, editFirmaForm,
      editFirmaGemeindeSearch, editFirmaGemeindeFocused, editFirmaGefilterteGemeinden,
      firmaBearbeiten, editFirmaSelectGemeinde, firmaSpeichern, firmaLoeschen,
      firmaProduktId, firmaProdukte, firmaProduktListe,
      editProduktId, editProduktForm, neuesProduktName,
      produktBearbeiten, produktSpeichern, produktLoeschen, produktHinzufuegen,
      kantonKuerzel,
      beitragSuche, beitragFilter, gefilterteBeitraegeAdmin,
      editBeitragId, editBeitragForm, editBeitragCompanySearch, editBeitragCompanyFocused,
      editBeitragGefilterteCompanies, editBeitragCompanyName, editBeitragProdukte, editBeitragSelectedObj,
      imageFile, imagePreview, imageUploading, onImageSelect, clearImage,
      editBeitragImageUrl, removeEditBeitragImage,
      beitragBearbeiten, beitragSpeichern, beitragLoeschen, beitragFlag,
      beitragKommentare, editKommentarId, editKommentarText,
      kommentarBearbeitenAdmin, kommentarSpeichernAdmin, kommentarLoeschenAdmin,
      openAuth, authSubmit, logout
    }
  }
}).mount('#app')
