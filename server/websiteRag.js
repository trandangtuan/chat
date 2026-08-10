import crypto from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { db } from './db.js'

const sitemapParser = new XMLParser({ ignoreAttributes: false })
const userAgent = process.env.WEBSITE_RAG_USER_AGENT || 'TDShiftChatRAG/0.1'
const maxPagesPerSource = Number(process.env.WEBSITE_RAG_MAX_PAGES || 200)
const crawlTimeoutMs = Number(process.env.WEBSITE_RAG_TIMEOUT_MS || 12000)
const chunkSize = Number(process.env.WEBSITE_RAG_CHUNK_SIZE || 12000)
const chunkOverlap = Number(process.env.WEBSITE_RAG_CHUNK_OVERLAP || 1200)

export async function indexWebsiteSource({ userId, sourceId, url }) {
  const baseUrl = normalizeWebsiteUrl(url)
  const urls = await discoverSitemapUrls(baseUrl)
  if (!urls.length) throw new Error('NO_SITEMAP_URLS_FOUND')

  const pages = []
  for (const pageUrl of urls.slice(0, maxPagesPerSource)) {
    const page = await fetchPage(pageUrl)
    if (page) pages.push(page)
  }
  if (!pages.length) throw new Error('NO_PAGES_CRAWLED')

  const replacePages = db.transaction(() => {
    db.prepare('DELETE FROM website_pages WHERE source_id = ? AND user_id = ?').run(sourceId, userId)
    db.prepare('DELETE FROM website_pages_fts WHERE source_id = ? AND user_id = ?').run(sourceId, userId)

    const insertPage = db.prepare(`
      INSERT INTO website_pages (id, source_id, user_id, url, title, chunk_index, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare(`
      INSERT INTO website_pages_fts (page_id, source_id, user_id, url, chunk_index, title, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    for (const page of pages) {
      const chunks = chunkText(page.content)
      chunks.forEach((chunk, index) => {
        const pageId = crypto.createHash('sha256').update(`${sourceId}:${page.url}:${index}`).digest('hex')
        insertPage.run(pageId, sourceId, userId, page.url, page.title, index, chunk)
        insertFts.run(pageId, sourceId, userId, page.url, index, page.title, chunk)
      })
    }
  })
  replacePages()

  return { discovered: urls.length, indexed: pages.length }
}

export function searchWebsiteContext({ userId, query, limit = 6 }) {
  const ftsQuery = makeFtsQuery(query)
  if (!ftsQuery) return []
  return db.prepare(`
    SELECT page_id, source_id, url, title, chunk_index,
           snippet(website_pages_fts, 5, '[', ']', ' ... ', 32) AS snippet,
           bm25(website_pages_fts) AS score
    FROM website_pages_fts
    WHERE user_id = ? AND website_pages_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(userId, ftsQuery, limit)
}

export function buildWebsiteContextBlock(matches) {
  if (!matches.length) return ''
  return [
    'Website knowledge base matches. Use these sources when relevant and cite URLs in the answer:',
    ...matches.map((match, index) => [
      `[${index + 1}] ${match.title || match.url}`,
      `URL: ${match.url}`,
      `Chunk: ${Number(match.chunk_index || 0) + 1}`,
      `Excerpt: ${stripHighlights(match.snippet || '')}`
    ].join('\n'))
  ].join('\n\n')
}

export function normalizeWebsiteUrl(value) {
  const withProtocol = value.trim().match(/^https?:\/\//i) ? value.trim() : `https://${value.trim()}`
  const url = new URL(withProtocol)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function discoverSitemapUrls(baseUrl) {
  const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'].map((path) => new URL(path, baseUrl).toString())
  const seen = new Set()
  const urls = []
  for (const sitemapUrl of candidates) {
    await parseSitemap(sitemapUrl, baseUrl, seen, urls)
    if (urls.length) break
  }
  return [...new Set(urls)].filter((url) => sameHost(baseUrl, url)).slice(0, maxPagesPerSource)
}

async function parseSitemap(sitemapUrl, baseUrl, seen, urls) {
  if (seen.has(sitemapUrl) || urls.length >= maxPagesPerSource) return
  seen.add(sitemapUrl)
  const text = await fetchText(sitemapUrl)
  if (!text) return

  let parsed
  try {
    parsed = sitemapParser.parse(text)
  } catch {
    return
  }

  const locs = collectLocs(parsed)
  for (const loc of locs) {
    if (!loc || urls.length >= maxPagesPerSource) continue
    if (loc.endsWith('.xml') || new URL(loc).pathname.toLowerCase().includes('sitemap')) {
      await parseSitemap(loc, baseUrl, seen, urls)
    } else if (sameHost(baseUrl, loc)) {
      urls.push(loc)
    }
  }
}

function collectLocs(value) {
  if (!value) return []
  if (typeof value === 'string') return []
  if (Array.isArray(value)) return value.flatMap(collectLocs)
  if (typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => key === 'loc' ? [String(child).trim()] : collectLocs(child))
}

async function fetchPage(url) {
  const response = await fetchWithTimeout(url)
  if (!response?.ok) return null
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('html')) return null
  const html = await response.text()
  const title = extractTitle(html) || url
  const content = htmlToText(html)
  if (content.length < 120) return null
  return { url: response.url || url, title: title.slice(0, 300), content }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url)
  if (!response?.ok) return ''
  return response.text()
}

async function fetchWithTimeout(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), crawlTimeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xml,text/xml,*/*' }
    })
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function extractTitle(html) {
  return cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
}

function htmlToText(html) {
  return cleanText(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
}

function cleanText(value) {
  return decodeHtml(value || '').replace(/\s+/g, ' ').trim()
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function sameHost(baseUrl, pageUrl) {
  try {
    const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '')
    const pageHost = new URL(pageUrl).hostname.replace(/^www\./, '')
    return baseHost === pageHost
  } catch {
    return false
  }
}

function makeFtsQuery(value) {
  const terms = String(value || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []
  return terms.filter((term) => term.length > 1).slice(0, 12).map((term) => `"${term}"`).join(' OR ')
}

function chunkText(content) {
  if (content.length <= chunkSize) return [content]
  const chunks = []
  let start = 0
  while (start < content.length) {
    let end = Math.min(start + chunkSize, content.length)
    if (end < content.length) {
      const boundary = Math.max(
        content.lastIndexOf('. ', end),
        content.lastIndexOf('? ', end),
        content.lastIndexOf('! ', end),
        content.lastIndexOf('\n', end)
      )
      if (boundary > start + chunkSize * 0.6) end = boundary + 1
    }
    chunks.push(content.slice(start, end).trim())
    if (end >= content.length) break
    start = Math.max(end - chunkOverlap, start + 1)
  }
  return chunks.filter(Boolean)
}

function stripHighlights(value) {
  return value.replaceAll('[', '').replaceAll(']', '')
}
