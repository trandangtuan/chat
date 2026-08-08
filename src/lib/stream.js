export async function streamMessage(conversationId, content, onDelta) {
  const response = await fetch(`/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content })
  })
  if (!response.ok || !response.body) throw new Error('STREAM_FAILED')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  let result = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''
    for (const eventBlock of events) {
      const parsed = parseSseEvent(eventBlock, currentEvent)
      currentEvent = parsed.lastEvent
      if (!parsed.data) continue
      if (parsed.event === 'delta') onDelta(parsed.data.delta || '')
      if (parsed.event === 'done') result = parsed.data
      if (parsed.event === 'error') throw new Error(parsed.data.error || 'STREAM_FAILED')
    }
  }

  if (!result) throw new Error('STREAM_INCOMPLETE')
  return result
}

function parseSseEvent(block, fallbackEvent) {
  let event = fallbackEvent
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  return {
    event,
    lastEvent: event,
    data: dataLines.length ? JSON.parse(dataLines.join('\n')) : null
  }
}
