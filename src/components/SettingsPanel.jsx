import React from 'react'
import { AlertTriangle, Boxes, Plus, ServerCog } from 'lucide-react'

export function SettingsPanel({
  mcpServers,
  skills,
  mcpForm,
  skillName,
  skillInstructions,
  onMcpFormChange,
  onSkillNameChange,
  onSkillInstructionsChange,
  onAddMcpServer,
  onAddSkill
}) {
  function updateMcpForm(patch) {
    onMcpFormChange((current) => ({ ...current, ...patch }))
  }

  return (
    <aside className="settings-panel">
      <section className="plugin-panel">
        <div className="settings-heading">
          <h3><ServerCog size={17} /> New Plugin</h3>
        </div>

        <form onSubmit={onAddMcpServer} className="plugin-form">
          <div className="icon-field">
            <button type="button" className="icon-upload" aria-label="Add plugin icon"><Plus size={22} /></button>
            <div>
              <label>Icon <span>(optional)</span></label>
              <small>PNG only. Best results at 256 x 256 px or larger. Max file size: 10 KB</small>
            </div>
          </div>

          <label className="field-label">
            Name
            <input value={mcpForm.name} onChange={(event) => updateMcpForm({ name: event.target.value })} placeholder="Custom Tool" />
          </label>

          <label className="field-label">
            Description <span>(optional)</span>
            <input value={mcpForm.description} onChange={(event) => updateMcpForm({ description: event.target.value })} placeholder="Explain what it does in a few words" />
          </label>

          <div className="field-label">
            <div className="connection-row">
              <span>Connection</span>
              <div className="segmented">
                <button type="button" className={mcpForm.connectionType === 'server_url' ? 'active' : ''} onClick={() => updateMcpForm({ connectionType: 'server_url' })}>Server URL</button>
                <button type="button" className={mcpForm.connectionType === 'tunnel' ? 'active' : ''} onClick={() => updateMcpForm({ connectionType: 'tunnel' })}>Tunnel</button>
              </div>
            </div>
            <input value={mcpForm.url} onChange={(event) => updateMcpForm({ url: event.target.value })} placeholder={mcpForm.connectionType === 'server_url' ? 'https://example.com/sse' : 'https://example.com/tunnel'} />
          </div>

          <label className="field-label">
            Authentication
            <select value={mcpForm.authType} onChange={(event) => updateMcpForm({ authType: event.target.value })}>
              <option value="oauth">OAuth</option>
              <option value="no_auth">No Auth</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>

          <div className="risk-note">
            <AlertTriangle size={17} />
            <span>Custom MCP servers introduce risk. <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">Learn more</a></span>
          </div>

          <button className="save-plugin" type="submit"><Plus size={16} /> Add MCP server</button>
        </form>

        <div className="server-list">
          {mcpServers.map((server) => <McpServerItem key={server.id} server={server} />)}
          {!mcpServers.length && <small>No MCP servers yet</small>}
        </div>
      </section>

      <section>
        <h3><Boxes size={17} /> Skills</h3>
        <form onSubmit={onAddSkill} className="skill-form">
          <input value={skillName} onChange={(event) => onSkillNameChange(event.target.value)} placeholder="Skill name" />
          <textarea value={skillInstructions} onChange={(event) => onSkillInstructionsChange(event.target.value)} placeholder="Instructions for this skill" />
          <button><Plus size={16} /> Add skill</button>
        </form>
        <div className="skill-list">
          {skills.map((skill) => <article key={skill.id}><strong>{skill.name}</strong><p>{skill.instructions}</p></article>)}
          {!skills.length && <small>No personal skills yet</small>}
        </div>
      </section>
    </aside>
  )
}

function McpServerItem({ server }) {
  return (
    <article className="server-item">
      <div className="server-avatar">{server.name?.[0]?.toUpperCase() || 'M'}</div>
      <div>
        <strong>{server.name}</strong>
        <p>{server.description || server.url || 'Custom MCP server'}</p>
        <small>{formatAuthType(server.authType)} · {server.connectionType === 'tunnel' ? 'Tunnel' : 'Server URL'}</small>
      </div>
    </article>
  )
}

function formatAuthType(authType) {
  if (authType === 'no_auth') return 'No Auth'
  if (authType === 'mixed') return 'Mixed'
  return 'OAuth'
}
