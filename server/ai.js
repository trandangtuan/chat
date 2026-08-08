import { config } from './config.js'

export async function generateAssistantReply({ user, messages, skills, mcpServers }) {
  const enabledSkills = skills.filter((skill) => skill.enabled)
  const enabledMcp = mcpServers.filter((server) => server.enabled)
  const system = [
    'You are TDShift Chat AI, a concise and useful assistant.',
    `Current user: ${user.name || user.email || user.id}.`,
    enabledSkills.length ? `User skills:\n${enabledSkills.map((skill) => `- ${skill.name}: ${skill.instructions}`).join('\n')}` : '',
    enabledMcp.length ? `Available user MCP servers:\n${enabledMcp.map((server) => `- ${server.name} (${server.transport})`).join('\n')}` : '',
    'Do not claim you executed MCP tools unless the application provided tool results.'
  ].filter(Boolean).join('\n\n')

  if (!config.openrouterApiKey) {
    const content = [
      'Mình đã nhận tin nhắn của bạn.',
      enabledSkills.length ? `Skill đang bật: ${enabledSkills.map((skill) => skill.name).join(', ')}.` : 'Bạn chưa bật skill riêng nào.',
      enabledMcp.length ? `MCP server đã cấu hình: ${enabledMcp.map((server) => server.name).join(', ')}.` : 'Bạn chưa cấu hình MCP server riêng.',
      'Để trả lời bằng model thật, hãy cấu hình OPENROUTER_API_KEY trên server.'
    ].join(' ')
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

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.openrouterApiKey}`,
      'content-type': 'application/json',
      'http-referer': config.openrouterSiteUrl,
      'x-title': config.openrouterAppName
    },
    body: JSON.stringify({
      model: config.openrouterModel,
      messages: [
        { role: 'system', content: system },
        ...messages.map((message) => ({ role: message.role, content: message.content }))
      ],
      temperature: 0.7
    })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('OpenRouter request failed', response.status, detail)
    throw new Error('OPENROUTER_REQUEST_FAILED')
  }

  const completion = await response.json()
  return {
    content: completion.choices?.[0]?.message?.content || 'Mình chưa tạo được câu trả lời.',
    usage: normalizeOpenRouterUsage(completion.usage)
  }
}

function normalizeOpenRouterUsage(usage = {}) {
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
