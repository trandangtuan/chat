import React from 'react'
import { Boxes, Plus, ServerCog } from 'lucide-react'

export function SettingsPanel({
  mcpServers,
  skills,
  mcpName,
  skillName,
  skillInstructions,
  onMcpNameChange,
  onSkillNameChange,
  onSkillInstructionsChange,
  onAddMcpServer,
  onAddSkill
}) {
  return (
    <aside className="settings-panel">
      <section>
        <h3><ServerCog size={17} /> MCP servers</h3>
        <form onSubmit={onAddMcpServer} className="inline-form">
          <input value={mcpName} onChange={(event) => onMcpNameChange(event.target.value)} placeholder="filesystem, postgres..." />
          <button><Plus size={16} /></button>
        </form>
        <div className="chips">
          {mcpServers.map((server) => <span key={server.id}>{server.name}</span>)}
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
