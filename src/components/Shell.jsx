import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Home, Swords, User, ClipboardList, Users, Check, X } from 'lucide-react'
import { RankBadge } from './ui'
import { useSession } from '../context/SessionContext'
import { getIncomingTrainInvites, getSentTrainInvites, respondTrainInvite } from '../lib/training'

const TABS = [
  { key: 'inicio', label: 'Início', icon: Home },
  { key: 'treinar', label: 'Treinar', icon: Swords },
  { key: 'ficha', label: 'Ficha', icon: ClipboardList },
  { key: 'perfil', label: 'Perfil', icon: User },
]

const SUB = { raid: 'Raid boss', missoes: 'Missões diárias' }
const POLL_MS = 10000

export default function Shell({ route, go, children }) {
  const { profile, user, notify } = useSession()
  const active = SUB[route.name] ? 'inicio' : route.name
  const name = profile?.hunter_name || profile?.name || 'Caçador'
  const mainRef = useRef(null)

  // a área de conteúdo é que rola (quando precisa), não a página inteira
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }) }, [route.name])

  // ---- convites de "treinar junto" ----
  const [incoming, setIncoming] = useState([])
  const sentRef = useRef(null) // id -> status, pra avisar quando o amigo responder
  useEffect(() => {
    if (!user) return
    let alive = true
    const tick = async () => {
      try {
        const [inc, sent] = await Promise.all([getIncomingTrainInvites(user.id), getSentTrainInvites(user.id)])
        if (!alive) return
        setIncoming(inc)
        const prev = sentRef.current
        const next = {}
        for (const s of sent) {
          next[s.id] = s.status
          const who = s.invitee?.hunter_name || s.invitee?.name || 'Seu amigo'
          if (prev && prev[s.id] === 'pending' && s.status === 'accepted') notify(`${who.toUpperCase()} TOPOU TREINAR JUNTO!`, 'gold')
          if (prev && prev[s.id] === 'pending' && s.status === 'declined') notify(`${who} não pode treinar agora`, 'red')
        }
        sentRef.current = next
      } catch { /* sem rede / tabela ainda não criada: ignora */ }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    const onFocus = () => document.visibilityState === 'visible' && tick()
    document.addEventListener('visibilitychange', onFocus)
    return () => { alive = false; clearInterval(id); document.removeEventListener('visibilitychange', onFocus) }
  }, [user?.id, notify])

  const answer = async (inv, accept) => {
    setIncoming((l) => l.filter((x) => x.id !== inv.id))
    try {
      await respondTrainInvite(inv.id, accept)
      if (accept) { notify('BORA! VOCÊS TREINAM JUNTOS HOJE', 'gold'); go('treinar') }
    } catch (e) {
      notify(`Não foi possível responder: ${e.message}`, 'red')
    }
  }

  const invite = incoming[0]
  const inviterName = invite?.inviter?.hunter_name || invite?.inviter?.name || 'Um amigo'

  return (
    <div className="app">
      <header className="topbar">
        {SUB[route.name] ? (
          <button className="icon-btn" onClick={() => go('inicio')} aria-label="Voltar ao início">
            <ChevronLeft size={20} />
          </button>
        ) : (
          <RankBadge rank={profile?.rank} />
        )}
        <div className="topbar-title">
          <h1 className="h-md glow">{SUB[route.name] || name}</h1>
        </div>
        <span className="chip chip-cyan mono">LVL.{profile?.level ?? 1}</span>
      </header>

      {invite && (
        <div className="invite-banner" role="alert">
          <Users size={20} />
          <div className="grow">
            <b>{inviterName} quer treinar junto!</b>
            <span className="mono tiny dim">
              {incoming.length > 1 ? `+${incoming.length - 1} convite(s) · ` : ''}bora hoje?
            </span>
          </div>
          <button className="icon-btn ok" onClick={() => answer(invite, true)} aria-label="Aceitar convite de treino"><Check size={18} /></button>
          <button className="icon-btn no" onClick={() => answer(invite, false)} aria-label="Recusar convite de treino"><X size={18} /></button>
        </div>
      )}

      <main className="content" ref={mainRef}>{children}</main>

      <nav className="nav" aria-label="Navegação principal">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={`nav-item ${active === key ? 'on' : ''}`} onClick={() => go(key)} aria-current={active === key ? 'page' : undefined}>
            <Icon size={20} />
            <span className="mono">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
