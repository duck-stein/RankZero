import { supabase } from './supabase'

// Convite para treinar junto. O amigo vê o pedido em qualquer tela (Shell faz o
// polling) e responde "bora" ou "agora não". Convites valem por 3 horas.
const TTL_MS = 3 * 60 * 60 * 1000
const since = () => new Date(Date.now() - TTL_MS).toISOString()
const PROFILE = 'id, hunter_name, name, tag, avatar_url, last_seen'

export async function sendTrainInvite(inviterId, inviteeId) {
  // evita empilhar convites: se já existe um pendente recente pra esse amigo, reaproveita
  const { data: open } = await supabase
    .from('training_invites')
    .select('id')
    .eq('inviter_id', inviterId)
    .eq('invitee_id', inviteeId)
    .eq('status', 'pending')
    .gte('created_at', since())
    .limit(1)
  if (open?.length) return open[0]
  const { data, error } = await supabase
    .from('training_invites')
    .insert({ inviter_id: inviterId, invitee_id: inviteeId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getIncomingTrainInvites(uid) {
  const { data, error } = await supabase
    .from('training_invites')
    .select(`id, created_at, inviter:profiles!training_invites_inviter_id_fkey(${PROFILE})`)
    .eq('invitee_id', uid)
    .eq('status', 'pending')
    .gte('created_at', since())
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function respondTrainInvite(id, accept) {
  const { error } = await supabase
    .from('training_invites')
    .update({ status: accept ? 'accepted' : 'declined', responded_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// Convites que EU enviei nas últimas 3h (pendentes ou já respondidos)
export async function getSentTrainInvites(uid) {
  const { data, error } = await supabase
    .from('training_invites')
    .select(`id, status, created_at, responded_at, invitee:profiles!training_invites_invitee_id_fkey(${PROFILE})`)
    .eq('inviter_id', uid)
    .gte('created_at', since())
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

// Parceiros de hoje: convites aceitos (nos dois sentidos) nas últimas 3h
export async function getTrainingBuddies(uid) {
  const { data, error } = await supabase
    .from('training_invites')
    .select(`id, inviter:profiles!training_invites_inviter_id_fkey(${PROFILE}), invitee:profiles!training_invites_invitee_id_fkey(${PROFILE})`)
    .eq('status', 'accepted')
    .or(`inviter_id.eq.${uid},invitee_id.eq.${uid}`)
    .gte('responded_at', since())
  if (error) throw error
  const seen = new Set()
  return data
    .map((r) => (r.inviter.id === uid ? r.invitee : r.inviter))
    .filter((p) => !seen.has(p.id) && seen.add(p.id))
}
