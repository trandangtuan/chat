import { Bot, Plus, Send, Sparkles, UserRound } from 'lucide-react'

export function ChatPanel({
  activeConversation,
  activeId,
  messages,
  draft,
  sending,
  onDraftChange,
  onSendMessage,
  onCreateConversation
}) {
  return (
    <main className="chat-panel">
      <header className="topbar">
        <div><span>Private workspace</span><h2>{activeConversation?.title || 'Start a new chat'}</h2></div>
        <div className="status-pill"><i /> SSO connected</div>
      </header>

      <section className="messages">
        {!activeId && (
          <div className="empty">
            <Bot size={34} />
            <h1>How can I help?</h1>
            <button onClick={onCreateConversation}><Plus size={17} /> Create your first chat</button>
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </section>

      <form className="composer" onSubmit={onSendMessage}>
        <textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="Message TDShift Chat AI" disabled={!activeId} />
        <button disabled={!activeId || sending || !draft.trim()}><Send size={18} /></button>
      </form>
    </main>
  )
}

function MessageBubble({ message }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="bubble-icon">{message.role === 'assistant' ? <Sparkles size={16} /> : <UserRound size={16} />}</div>
      <p>{message.streaming && !message.content ? <span className="thinking">Thinking...</span> : message.content}</p>
    </article>
  )
}
