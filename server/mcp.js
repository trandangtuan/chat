import { nanoid } from 'nanoid'
import { db } from './db.js'

export async function refreshMcpToolsForServer(userId, serverId) {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(serverId, userId)
  if (!server) throw notFound('MCP_SERVER_NOT_FOUND')
  if (server.connection_status !== 'connected') return []

  const result = await callMcpRpc(server, 'tools/list', {})
  const tools = Array.isArray(result?.tools) ? result.tools : []
  const replaceTools = db.transaction(() => {
    db.prepare('DELETE FROM mcp_tools WHERE mcp_server_id = ? AND user_id = ?').run(server.id, userId)
    const insert = db.prepare(`
      INSERT INTO mcp_tools (id, user_id, mcp_server_id, name, description, input_schema_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const tool of tools) {
      insert.run(
        nanoid(),
        userId,
        server.id,
        String(tool.name),
        tool.description || null,
        JSON.stringify(tool.inputSchema || tool.input_schema || {})
      )
    }
  })
  replaceTools()
  return listMcpTools(userId, server.id)
}

export function listMcpTools(userId, serverId) {
  return db.prepare(`
    SELECT id, name, description, input_schema_json
    FROM mcp_tools
    WHERE user_id = ? AND mcp_server_id = ?
    ORDER BY name ASC
  `).all(userId, serverId).map(normalizeTool)
}

export function buildOpenRouterTools(userId) {
  const rows = db.prepare(`
    SELECT tools.id, tools.name, tools.description, tools.input_schema_json,
           servers.id AS server_id, servers.name AS server_name
    FROM mcp_tools AS tools
    JOIN mcp_servers AS servers ON servers.id = tools.mcp_server_id
    WHERE tools.user_id = ?
      AND servers.user_id = ?
      AND servers.enabled = 1
      AND servers.connection_status = 'connected'
    ORDER BY servers.name ASC, tools.name ASC
  `).all(userId, userId)

  return rows.map((tool) => ({
    type: 'function',
    function: {
      name: encodeToolName(tool.id),
      description: `[${tool.server_name}] ${tool.description || tool.name}`,
      parameters: safeJson(tool.input_schema_json)
    }
  }))
}

export async function executeOpenRouterTool(userId, toolCall) {
  const decoded = decodeToolName(toolCall.function.name)
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ? AND connection_status = ?')
    .get(decoded.serverId, userId, 'connected')
  if (!server) throw notFound('MCP_SERVER_NOT_FOUND')
  const args = safeJson(toolCall.function.arguments || '{}')
  const result = await callMcpRpc(server, 'tools/call', { name: decoded.toolName, arguments: args })
  return JSON.stringify(result ?? {})
}

async function callMcpRpc(server, method, params) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(server.oauth_access_token ? { authorization: `Bearer ${server.oauth_access_token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nanoid(), method, params })
  })
  const text = await response.text()
  if (!response.ok) {
    console.error('MCP request failed', response.status, text)
    throw new Error('MCP_REQUEST_FAILED')
  }
  const payload = parseMcpResponse(text)
  if (payload.error) throw new Error(payload.error.message || 'MCP_RPC_ERROR')
  return payload.result
}

function parseMcpResponse(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('data:')) {
    const line = trimmed.split('\n').find((item) => item.startsWith('data:'))
    return JSON.parse(line.slice(5).trim())
  }
  return JSON.parse(trimmed)
}

function encodeToolName(toolId) {
  return `mcp_${toolId.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

function decodeToolName(encoded) {
  const match = encoded.match(/^mcp_(.+)$/)
  if (!match) throw new Error('INVALID_TOOL_NAME')
  const toolKey = match[1]
  const row = db.prepare(`
    SELECT tools.name AS tool_name, servers.id AS server_id
    FROM mcp_tools AS tools
    JOIN mcp_servers AS servers ON servers.id = tools.mcp_server_id
    WHERE replace(tools.id, '-', '_') = ?
    LIMIT 1
  `).get(toolKey)
  if (!row) throw new Error('TOOL_NOT_FOUND')
  return { serverId: row.server_id, toolName: row.tool_name }
}

function normalizeTool(tool) {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    inputSchema: safeJson(tool.input_schema_json)
  }
}

function safeJson(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value || '{}') : value || {}
  } catch {
    return {}
  }
}

function notFound(message) {
  const error = new Error(message)
  error.status = 404
  return error
}
