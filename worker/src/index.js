const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const formData = await request.formData()
        const file = formData.get('file')
        if (!file) return json({ error: 'No file' }, 400)
        if (!ALLOWED_TYPES.includes(file.type)) return json({ error: 'Invalid type' }, 400)
        if (file.size > MAX_SIZE) return json({ error: 'File too large' }, 400)

        const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1]
        const key = `posts/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`

        await env.BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        })

        const publicUrl = `https://pub-goppf-images.r2.dev/${key}`
        return json({ url: publicUrl, key })
      } catch (e) {
        return json({ error: e.message }, 500)
      }
    }

    if (request.method === 'DELETE' && url.pathname === '/delete') {
      const key = url.searchParams.get('key')
      if (!key) return json({ error: 'No key' }, 400)
      await env.BUCKET.delete(key)
      return json({ ok: true })
    }

    return json({ error: 'Not found' }, 404)
  },
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
