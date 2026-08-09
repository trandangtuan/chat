import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sparkles } from 'lucide-react'
import { ChatPanel } from './components/ChatPanel.jsx'
import { LoginScreen } from './components/LoginScreen.jsx'
import { SettingsPanel } from './components/SettingsPanel.jsx'
import { Sidebar } from './components/Sidebar.jsx'
import { api } from './lib/api.js'
import { streamMessage } from './lib/stream.js'
import './styles.css'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [mcpServers, setMcpServers] = useState([])
  const [skills, setSkills] = useState([])
  const [rules, setRules] = useState([])
  const [memories, setMemories] = useState([])
  const [mcpForm, setMcpForm] = useState(createEmptyMcpForm())
  const [skillName, setSkillName] = useState('')
  const [skillInstructions, setSkillInstructions] = useState('')
  const [ruleTitle, setRuleTitle] = useState('')
  const [ruleInstruction, setRuleInstruction] = useState('')
  const [memoryTitle, setMemoryTitle] = useState('')
  const [memoryContent, setMemoryContent] = useState('')

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId),
    [activeId, conversations]
  )

  useEffect(() => {
    bootstrap()
  }, [])

  useEffect(() => {
    if (!activeId) return
    api.get(`/api/conversations/${activeId}/messages`)
      .then((data) => setMessages(data.messages))
      .catch(() => setMessages([]))
  }, [activeId])

  async function bootstrap() {
    try {
      const identity = await api.get('/api/me')
      setUser(identity.user)
      const [conversationData, mcpData, skillData, ruleData, memoryData] = await Promise.all([
        api.get('/api/conversations'),
        api.get('/api/mcp-servers'),
        api.get('/api/skills'),
        api.get('/api/rules'),
        api.get('/api/memories')
      ])
      setConversations(conversationData.conversations)
      setActiveId(conversationData.conversations[0]?.id || null)
      setMcpServers(mcpData.mcpServers)
      setSkills(skillData.skills)
      setRules(ruleData.rules)
      setMemories(memoryData.memories)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  async function createConversation() {
    const data = await api.post('/api/conversations', { title: 'New chat' })
    setConversations((current) => [data.conversation, ...current])
    setActiveId(data.conversation.id)
    setMessages([])
  }

  async function sendMessage(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || !activeId || sending) return
    const localUserId = `local-user-${Date.now()}`
    const assistantId = `stream-${Date.now()}`
    setDraft('')
    setSending(true)
    setMessages((current) => [
      ...current,
      { id: localUserId, role: 'user', content },
      { id: assistantId, role: 'assistant', content: '', streaming: true }
    ])

    try {
      const result = await streamMessage(activeId, content, (delta) => {
        setMessages((current) => current.map((message) => message.id === assistantId
          ? { ...message, content: `${message.content || ''}${delta}` }
          : message))
      })
      setMessages((current) => current.map((message) => {
        if (message.id === localUserId) return result.userMessage
        if (message.id === assistantId) return result.assistantMessage
        return message
      }))
      const refreshed = await api.get('/api/conversations')
      setConversations(refreshed.conversations)
    } catch {
      setMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, content: 'Không thể stream câu trả lời. Vui lòng thử lại.', streaming: false }
        : message))
    } finally {
      setSending(false)
    }
  }

  async function addMcpServer(event) {
    event.preventDefault()
    if (!mcpForm.name.trim()) return
    const data = await api.post('/api/mcp-servers', {
      name: mcpForm.name.trim(),
      description: mcpForm.description.trim() || null,
      iconUrl: mcpForm.iconUrl.trim() || null,
      connectionType: mcpForm.connectionType,
      authType: mcpForm.authType,
      transport: mcpForm.connectionType === 'server_url' ? 'sse' : 'http',
      url: mcpForm.url.trim() || null,
      env: {}
    })
    setMcpServers((current) => [data.mcpServer, ...current])
    setMcpForm(createEmptyMcpForm())
  }

  async function addSkill(event) {
    event.preventDefault()
    if (!skillName.trim() || !skillInstructions.trim()) return
    const data = await api.post('/api/skills', { name: skillName.trim(), instructions: skillInstructions.trim() })
    setSkills((current) => [data.skill, ...current])
    setSkillName('')
    setSkillInstructions('')
  }

  async function addRule(event) {
    event.preventDefault()
    if (!ruleTitle.trim() || !ruleInstruction.trim()) return
    const data = await api.post('/api/rules', { title: ruleTitle.trim(), instruction: ruleInstruction.trim() })
    setRules((current) => [data.rule, ...current])
    setRuleTitle('')
    setRuleInstruction('')
  }

  async function addMemory(event) {
    event.preventDefault()
    if (!memoryTitle.trim() || !memoryContent.trim()) return
    const data = await api.post('/api/memories', { title: memoryTitle.trim(), content: memoryContent.trim() })
    setMemories((current) => [data.memory, ...current])
    setMemoryTitle('')
    setMemoryContent('')
  }

  async function logout() {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
    window.location.reload()
  }

  if (loading) {
    return <div className="center-screen"><Sparkles size={22} /> Loading workspace</div>
  }

  if (!user) {
    return <LoginScreen />
  }

  return (
    <div className="app-shell">
      <Sidebar
        user={user}
        conversations={conversations}
        activeId={activeId}
        onCreateConversation={createConversation}
        onSelectConversation={setActiveId}
        onLogout={logout}
      />
      <ChatPanel
        activeConversation={activeConversation}
        activeId={activeId}
        messages={messages}
        draft={draft}
        sending={sending}
        onDraftChange={setDraft}
        onSendMessage={sendMessage}
        onCreateConversation={createConversation}
      />
      <SettingsPanel
        mcpServers={mcpServers}
        skills={skills}
        rules={rules}
        memories={memories}
        mcpForm={mcpForm}
        skillName={skillName}
        skillInstructions={skillInstructions}
        ruleTitle={ruleTitle}
        ruleInstruction={ruleInstruction}
        memoryTitle={memoryTitle}
        memoryContent={memoryContent}
        onMcpFormChange={setMcpForm}
        onSkillNameChange={setSkillName}
        onSkillInstructionsChange={setSkillInstructions}
        onRuleTitleChange={setRuleTitle}
        onRuleInstructionChange={setRuleInstruction}
        onMemoryTitleChange={setMemoryTitle}
        onMemoryContentChange={setMemoryContent}
        onAddMcpServer={addMcpServer}
        onAddSkill={addSkill}
        onAddRule={addRule}
        onAddMemory={addMemory}
      />
    </div>
  )
}

function createEmptyMcpForm() {
  return {
    name: '',
    description: '',
    iconUrl: '',
    connectionType: 'server_url',
    url: '',
    authType: 'oauth'
  }
}

createRoot(document.getElementById('root')).render(<App />)
