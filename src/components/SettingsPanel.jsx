import React, { useState } from 'react'
import { AlertTriangle, ArrowLeft, Boxes, Brain, ListChecks, Plus, ServerCog, Trash2 } from 'lucide-react'

export function SettingsPanel({
  mcpServers,
  skills,
  rules,
  memories,
  settingsError,
  mcpForm,
  skillName,
  skillInstructions,
  ruleTitle,
  ruleInstruction,
  memoryTitle,
  memoryContent,
  onMcpFormChange,
  onSkillNameChange,
  onSkillInstructionsChange,
  onRuleTitleChange,
  onRuleInstructionChange,
  onMemoryTitleChange,
  onMemoryContentChange,
  onAddMcpServer,
  onConnectMcpServer,
  onDeleteMcpServer,
  onRefreshMcpTools,
  onAddSkill,
  onAddRule,
  onAddMemory
}) {
  const [mcpView, setMcpView] = useState('list')

  function updateMcpForm(patch) {
    onMcpFormChange((current) => ({ ...current, ...patch }))
  }

  async function submitMcpServer(event) {
    event.preventDefault()
    if (!mcpForm.name.trim()) return
    await onAddMcpServer(event)
    setMcpView('list')
  }

  return (
    <aside className="settings-panel">
      {settingsError && <div className="settings-error">{settingsError}</div>}
      {mcpView === 'add' ? (
        <NewPluginForm
          mcpForm={mcpForm}
          onUpdate={updateMcpForm}
          onSubmit={submitMcpServer}
          onBack={() => setMcpView('list')}
        />
      ) : (
        <McpServerList servers={mcpServers} onAdd={() => setMcpView('add')} onConnect={onConnectMcpServer} onDelete={onDeleteMcpServer} onRefreshTools={onRefreshMcpTools} />
      )}

      <section>
        <h3><ListChecks size={17} /> Rules</h3>
        <form onSubmit={onAddRule} className="setting-form">
          <input value={ruleTitle} onChange={(event) => onRuleTitleChange(event.target.value)} placeholder="Rule name" />
          <textarea value={ruleInstruction} onChange={(event) => onRuleInstructionChange(event.target.value)} placeholder="Always answer in Vietnamese, be concise..." />
          <button><Plus size={16} /> Add rule</button>
        </form>
        <SettingItemList items={rules} emptyText="No rules yet" contentKey="instruction" />
      </section>

      <section>
        <h3><Brain size={17} /> Memory</h3>
        <form onSubmit={onAddMemory} className="setting-form">
          <input value={memoryTitle} onChange={(event) => onMemoryTitleChange(event.target.value)} placeholder="Memory title" />
          <textarea value={memoryContent} onChange={(event) => onMemoryContentChange(event.target.value)} placeholder="Remember this user's preferences, projects, or context" />
          <button><Plus size={16} /> Add memory</button>
        </form>
        <SettingItemList items={memories} emptyText="No memory saved yet" contentKey="content" />
      </section>

      <section>
        <h3><Boxes size={17} /> Skills</h3>
        <form onSubmit={onAddSkill} className="setting-form">
          <input value={skillName} onChange={(event) => onSkillNameChange(event.target.value)} placeholder="Skill name" />
          <textarea value={skillInstructions} onChange={(event) => onSkillInstructionsChange(event.target.value)} placeholder="Instructions for this skill" />
          <button><Plus size={16} /> Add skill</button>
        </form>
        <SettingItemList items={skills} emptyText="No personal skills yet" titleKey="name" contentKey="instructions" />
      </section>
    </aside>
  )
}

function SettingItemList({ items, emptyText, titleKey = 'title', contentKey }) {
  return (
    <div className="setting-item-list">
      {items.map((item) => <article key={item.id}><strong>{item[titleKey]}</strong><p>{item[contentKey]}</p></article>)}
      {!items.length && <small>{emptyText}</small>}
    </div>
  )
}

function McpServerList({ servers, onAdd, onConnect, onDelete, onRefreshTools }) {
  return (
    <section className="mcp-list-panel">
      <div className="section-header">
        <h3><ServerCog size={17} /> MCP servers</h3>
        <button type="button" onClick={onAdd}><Plus size={16} /> Add</button>
      </div>
      <div className="server-list light">
        {servers.map((server) => <McpServerItem key={server.id} server={server} onConnect={onConnect} onDelete={onDelete} onRefreshTools={onRefreshTools} />)}
        {!servers.length && (
          <div className="empty-list">
            <ServerCog size={24} />
            <strong>No MCP servers yet</strong>
            <small>Add a custom MCP server to make it available in your private workspace.</small>
            <button type="button" onClick={onAdd}><Plus size={16} /> Add MCP server</button>
          </div>
        )}
      </div>
    </section>
  )
}

function NewPluginForm({ mcpForm, onUpdate, onSubmit, onBack }) {
  return (
    <section className="plugin-panel">
      <div className="settings-heading">
        <button className="back-button" type="button" onClick={onBack} aria-label="Back to MCP server list"><ArrowLeft size={17} /></button>
        <h3>New Plugin</h3>
      </div>

      <form onSubmit={onSubmit} className="plugin-form">
        <div className="icon-field">
          <button type="button" className="icon-upload" aria-label="Add plugin icon"><Plus size={22} /></button>
          <div>
            <label>Icon <span>(optional)</span></label>
            <small>PNG only. Best results at 256 x 256 px or larger. Max file size: 10 KB</small>
          </div>
        </div>

        <label className="field-label">
          Name
          <input value={mcpForm.name} onChange={(event) => onUpdate({ name: event.target.value })} placeholder="Custom Tool" />
        </label>

        <label className="field-label">
          Description <span>(optional)</span>
          <input value={mcpForm.description} onChange={(event) => onUpdate({ description: event.target.value })} placeholder="Explain what it does in a few words" />
        </label>

        <div className="field-label">
          <div className="connection-row">
            <span>Connection</span>
            <div className="segmented">
              <button type="button" className={mcpForm.connectionType === 'server_url' ? 'active' : ''} onClick={() => onUpdate({ connectionType: 'server_url' })}>Server URL</button>
              <button type="button" className={mcpForm.connectionType === 'tunnel' ? 'active' : ''} onClick={() => onUpdate({ connectionType: 'tunnel' })}>Tunnel</button>
            </div>
          </div>
          <input value={mcpForm.url} onChange={(event) => onUpdate({ url: event.target.value })} placeholder={mcpForm.connectionType === 'server_url' ? 'https://example.com/sse' : 'https://example.com/tunnel'} />
        </div>

        <label className="field-label">
          Authentication
          <select value={mcpForm.authType} onChange={(event) => onUpdate({ authType: event.target.value })}>
            <option value="oauth">OAuth</option>
            <option value="no_auth">No Auth</option>
            <option value="mixed">Mixed</option>
          </select>
        </label>

        {mcpForm.authType !== 'no_auth' && (
          <div className="oauth-fields">
            <small>After saving, click Connect. The MCP server opens in your browser so you can sign in and approve access there.</small>
          </div>
        )}

        <div className="risk-note">
          <AlertTriangle size={17} />
          <span>Custom MCP servers introduce risk. <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">Learn more</a></span>
        </div>

        <div className="plugin-actions">
          <button className="cancel-plugin" type="button" onClick={onBack}>Cancel</button>
          <button className="save-plugin" type="submit"><Plus size={16} /> Add MCP server</button>
        </div>
      </form>
    </section>
  )
}

function McpServerItem({ server, onConnect, onDelete, onRefreshTools }) {
  const needsConnect = server.authType !== 'no_auth' && server.connectionStatus !== 'connected'
  const tools = server.tools || []
  return (
    <article className="server-item">
      <div className="server-avatar">{server.name?.[0]?.toUpperCase() || 'M'}</div>
      <div>
        <strong>{server.name}</strong>
        <p>{server.description || server.url || 'Custom MCP server'}</p>
        <small>{formatAuthType(server.authType)} · {server.connectionType === 'tunnel' ? 'Tunnel' : 'Server URL'} · {server.connectionStatus === 'connected' ? 'Connected' : 'Pending'}</small>
        {needsConnect && !server.url && <small className="server-warning">Missing server URL</small>}
        <div className="server-actions">
          {needsConnect && <button className="connect-server" type="button" onClick={() => onConnect(server.id)}>Connect</button>}
          {server.connectionStatus === 'connected' && <button className="refresh-tools" type="button" onClick={() => onRefreshTools(server.id)}>Refresh tools</button>}
          <button className="delete-server" type="button" onClick={() => onDelete(server.id)} aria-label={`Delete ${server.name}`}><Trash2 size={14} /> Delete</button>
        </div>
        {server.connectionStatus === 'connected' && (
          <div className="tool-list">
            {tools.map((tool) => <span key={tool.id || tool.name} title={tool.description || tool.name}>{tool.name}</span>)}
            {!tools.length && <small>No tools loaded yet</small>}
          </div>
        )}
      </div>
    </article>
  )
}

function formatAuthType(authType) {
  if (authType === 'no_auth') return 'No Auth'
  if (authType === 'mixed') return 'Mixed'
  return 'OAuth'
}
