import { config } from './config.js'
import { buildOpenRouterTools, executeOpenRouterTool } from './mcp.js'

export async function generateAssistantReply({ user, messages, skills, mcpServers, rules, memories, websiteContext = '' }) {
  const request = await buildChatRequest({ user, messages, skills, mcpServers, rules, memories, websiteContext })
  if (!config.openrouterApiKey) {
    const content = buildLocalReply(request)
    return {
      content,
      usage: {
        provider: 'local',
        model: 'mock',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        raw: {}
      }
    }
  }

  const completion = await createOpenRouterCompletion(request, false, user.id)
  return {
    content: completion.choices?.[0]?.message?.content || 'Mình chưa tạo được câu trả lời.',
    usage: normalizeUsage(completion.usage)
  }
}

export async function streamAssistantReply({ user, messages, skills, mcpServers, rules, memories, websiteContext = '', onDelta }) {
  const request = await buildChatRequest({ user, messages, skills, mcpServers, rules, memories, websiteContext })
  if (!config.openrouterApiKey) {
    const content = buildLocalReply(request)
    await onDelta(content)
    return {
      content,
      usage: {
        provider: 'local',
        model: 'mock',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        raw: {}
      }
    }
  }

  const tools = buildOpenRouterTools(user.id)
  if (tools.length) {
    const completion = await createOpenRouterCompletion(request, false, user.id)
    const content = completion.choices?.[0]?.message?.content || 'Mình chưa tạo được câu trả lời.'
    await onDelta(content)
    return { content, usage: normalizeUsage(completion.usage) }
  }

  const response = await createOpenRouterStream(request)
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let usage = null

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const payload = JSON.parse(data)
      if (payload.usage) usage = payload.usage
      const delta = payload.choices?.[0]?.delta?.content || ''
      if (delta) {
        content += delta
        await onDelta(delta)
      }
    }
  }

  return {
    content: content || 'Mình chưa tạo được câu trả lời.',
    usage: normalizeUsage(usage || {})
  }
}

async function buildChatRequest({ user, messages, skills, mcpServers, rules = [], memories = [], websiteContext = '' }) {
  const enabledSkills = skills.filter((skill) => skill.enabled)
  const selectedSkills = await selectRelevantSkills({ messages, skills: enabledSkills })
  const enabledMcp = mcpServers.filter((server) => server.enabled)
  const enabledRules = rules.filter((rule) => rule.enabled)
  const enabledMemories = memories.filter((memory) => memory.enabled)
  const system = [
    'You are TDShift Chat AI, a concise and useful assistant.',
    `Current user: ${user.name || user.email || user.id}.`,
    enabledRules.length ? `User rules:\n${enabledRules.map((rule) => `- ${rule.title}: ${rule.instruction}`).join('\n')}` : '',
    enabledMemories.length ? `User memory:\n${enabledMemories.map((memory) => `- ${memory.title}: ${memory.content}`).join('\n')}` : '',
    enabledSkills.length ? `Available user skills:\n${enabledSkills.map((skill) => `- ${skill.name}: ${skill.description || 'No description provided.'}`).join('\n')}` : '',
    selectedSkills.length ? `Selected skill instructions:\n${selectedSkills.map((skill) => `## ${skill.name}\n${skill.instructions}`).join('\n\n')}` : 'No user skill instructions were selected for this request.',
    websiteContext ? `Retrieved website context:\n${websiteContext}` : '',
    enabledMcp.length ? `Available user MCP servers:\n${enabledMcp.map((server) => `- ${server.name} (${server.transport})`).join('\n')}` : '',
    'Do not claim you executed MCP tools unless the application provided tool results.'
  ].filter(Boolean).join('\n\n')

  return {
    enabledSkills,
    selectedSkills,
    enabledMcp,
    enabledRules,
    enabledMemories,
    messages: [
      { role: 'system', content: system },
      ...messages.map((message) => ({ role: message.role, content: message.content }))
    ]
  }
}

async function selectRelevantSkills({ messages, skills }) {
  if (!skills.length) return []
  if (!config.openrouterApiKey) return skills

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || ''
  if (!latestUserMessage.trim()) return []

  const catalog = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description || ''
  }))

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouterModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'Choose which user skills are relevant for the next assistant response.',
            'You only see the skill name and description at this step.',
            'Return strict JSON with this shape: {"skill_ids":["id"]}.',
            'Return an empty array when no skill is relevant.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            latest_user_message: latestUserMessage,
            available_skills: catalog
          })
        }
      ]
    })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('OpenRouter skill selection failed', response.status, detail)
    return []
  }

  const completion = await response.json()
  const content = completion.choices?.[0]?.message?.content || ''
  const selectedIds = parseSelectedSkillIds(content)
  const selected = new Set(selectedIds)
  return skills.filter((skill) => selected.has(skill.id))
}

function parseSelectedSkillIds(content) {
  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed.skill_ids)) return []
    return parsed.skill_ids.map(String)
  } catch {
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return []
    try {
      const parsed = JSON.parse(match[0])
      return Array.isArray(parsed.skill_ids) ? parsed.skill_ids.map(String) : []
    } catch {
      return []
    }
  }
}

function buildLocalReply({ enabledSkills, enabledMcp, enabledRules, enabledMemories }) {
  return [
    'Mình đã nhận tin nhắn của bạn.',
    enabledRules.length ? `Rule đang bật: ${enabledRules.map((rule) => rule.title).join(', ')}.` : 'Bạn chưa bật rule riêng nào.',
    enabledMemories.length ? `Memory đang có: ${enabledMemories.map((memory) => memory.title).join(', ')}.` : 'Bạn chưa lưu memory riêng nào.',
    enabledSkills.length ? `Skill đang bật: ${enabledSkills.map((skill) => skill.name).join(', ')}.` : 'Bạn chưa bật skill riêng nào.',
    enabledMcp.length ? `MCP server đã cấu hình: ${enabledMcp.map((server) => server.name).join(', ')}.` : 'Bạn chưa cấu hình MCP server riêng.',
    'Để trả lời bằng model thật, hãy cấu hình OPENROUTER_API_KEY trên server.'
  ].join(' ')
}

async function createOpenRouterCompletion(request, stream, userId) {
  const tools = buildOpenRouterRequestTools(userId)
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouterModel,
      messages: request.messages,
      temperature: 0.7,
      stream,
      tools,
      tool_choice: 'auto'
    })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('OpenRouter request failed', response.status, detail)
    throw new Error('OPENROUTER_REQUEST_FAILED')
  }

  const completion = await response.json()
  const message = completion.choices?.[0]?.message
  if (!message?.tool_calls?.length || !userId) return completion

  const toolMessages = []
  for (const toolCall of message.tool_calls) {
    if (toolCall.type !== 'function' || !toolCall.function?.name?.startsWith('mcp_')) continue
    const content = await executeOpenRouterTool(userId, toolCall)
    toolMessages.push({ role: 'tool', tool_call_id: toolCall.id, content })
  }
  if (!toolMessages.length) return completion

  const finalResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouterModel,
      messages: [...request.messages, message, ...toolMessages],
      temperature: 0.7,
      tools,
      tool_choice: 'auto'
    })
  })
  if (!finalResponse.ok) {
    const detail = await finalResponse.text().catch(() => '')
    console.error('OpenRouter final tool response failed', finalResponse.status, detail)
    throw new Error('OPENROUTER_REQUEST_FAILED')
  }
  const finalCompletion = await finalResponse.json()
  finalCompletion.usage = mergeUsage(completion.usage, finalCompletion.usage)
  return finalCompletion
}

async function createOpenRouterStream(request) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouterModel,
      messages: request.messages,
      temperature: 0.7,
      stream: true,
      usage: { include: true },
      tools: buildOpenRouterRequestTools(),
      tool_choice: 'auto'
    })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('OpenRouter request failed', response.status, detail)
    throw new Error('OPENROUTER_REQUEST_FAILED')
  }

  return response
}

function buildOpenRouterRequestTools(userId) {
  return [
    { type: 'openrouter:web_search' },
    ...(userId ? buildOpenRouterTools(userId) : [])
  ]
}

function openRouterHeaders() {
  return {
    authorization: `Bearer ${config.openrouterApiKey}`,
    'content-type': 'application/json',
    'http-referer': config.openrouterSiteUrl,
    'x-title': config.openrouterAppName
  }
}

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens || 0)
  const completionTokens = Number(usage.completion_tokens || 0)
  return {
    provider: 'openrouter',
    model: config.openrouterModel,
    promptTokens,
    completionTokens,
    totalTokens: Number(usage.total_tokens || promptTokens + completionTokens),
    raw: usage
  }
}

function mergeUsage(first = {}, second = {}) {
  return {
    prompt_tokens: Number(first.prompt_tokens || 0) + Number(second.prompt_tokens || 0),
    completion_tokens: Number(first.completion_tokens || 0) + Number(second.completion_tokens || 0),
    total_tokens: Number(first.total_tokens || 0) + Number(second.total_tokens || 0)
  }
}
