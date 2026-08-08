import { Sparkles, UserRound } from 'lucide-react'

export function LoginScreen() {
  return (
    <main className="login-screen">
      <section className="login-visual">
        <div className="product-mark"><Sparkles size={22} /></div>
        <h1>TDShift Chat AI</h1>
        <p>ChatGPT-style workspace for many users, with SSO identity, private conversations, personal MCP servers, and personal skills.</p>
        <a className="primary-link" href="/auth/login"><UserRound size={18} /> Sign in with TDShift SSO</a>
      </section>
    </main>
  )
}
