import { ChevronRight, LogOut, MessageSquare, Plus, Sparkles } from 'lucide-react'

export function Sidebar({ user, conversations, activeId, onCreateConversation, onSelectConversation, onLogout }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-icon"><Sparkles size={18} /></div>
        <div><strong>TDShift Chat</strong><span>{user.email || user.id}</span></div>
      </div>
      <button className="new-chat" onClick={onCreateConversation}><Plus size={18} /> New chat</button>
      <nav className="conversation-list">
        {conversations.map((conversation) => (
          <button key={conversation.id} className={conversation.id === activeId ? 'active' : ''} onClick={() => onSelectConversation(conversation.id)}>
            <MessageSquare size={16} />
            <span>{conversation.title}</span>
            <ChevronRight size={15} />
          </button>
        ))}
      </nav>
      <button className="logout-button" onClick={onLogout}><LogOut size={16} /> Sign out</button>
    </aside>
  )
}
