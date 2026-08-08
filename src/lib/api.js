export const api = {
  async get(path) {
    const response = await fetch(path, { credentials: 'include' })
    if (!response.ok) throw new Error(path)
    return response.json()
  },
  async post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(path)
    return response.json()
  }
}
