import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, FastForward, SkipForward, Swords, Timer, Users, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useSession } from '../context/SessionContext'
import { useNow, useQuery, must } from '../lib/useQuery'
import { flatExercises, getWorkouts } from '../lib/workouts'
import { clock, damageOf, damageOfMinutes, fmt, fmt1, levelUnlocks, localDate, xpOf } from '../lib/rpg'
import { Btn, Chip, Empty, ErrorNote, Loading, Panel, SegBar, SysHead } from '../components/ui'
import { getTrainingBuddies } from '../lib/training'
import { getBoss, getDailyMonster, getGlobalBoss, hitGlobalBoss, abandonDailyMonster, getRaidPartners, getRaidDamageByMember } from '../lib/data'
import { INVOKABLE_BOSSES } from '../lib/rpg'

const REST_KEY = 'abibas_rest_seconds'
export const getRestSeconds = () => Number(localStorage.getItem(REST_KEY)) || 90

// a ficha ativa (qual ficha o caçador estava treinando) sobrevive à troca de
// tela — assim, sair pro início/ficha e voltar pra "Treinar" retoma o mesmo
// treino em vez de mostrar a lista de fichas de novo
const activeWorkoutKey = (uid) => `rankzero_active_workout_${uid}`

export default function Treinar({ go, params }) {
  const { user } = useSession()
  const [workoutId, setWorkoutId] = useState(() => params?.workoutId || localStorage.getItem(activeWorkoutKey(user.id)) || null)
  const q = useQuery(getWorkouts, [])

  useEffect(() => {
    const key = activeWorkoutKey(user.id)
    if (workoutId) localStorage.setItem(key, workoutId)
    else localStorage.removeItem(key)
  }, [workoutId, user.id])

  if (q.loading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const list = q.data || []

  if (!list.length) {
    return (
      <Empty title="Nenhuma ficha de treino" action={<Btn onClick={() => go('ficha')}>Criar minha primeira ficha</Btn>}>
        Monte uma ficha com as máquinas e exercícios que você usa. Depois volte aqui para atacar.
      </Empty>
    )
  }

  const workout = list.find((w) => w.id === workoutId)
  if (!workout) {
    return (
      <div className="stack">
        <SysHead>[QUAL FICHA HOJE?]</SysHead>
        {list.map((w) => {
          const n = flatExercises(w).length
          return (
            <button key={w.id} className="panel pick" onClick={() => setWorkoutId(w.id)} disabled={!n}>
              <span className="letter">{w.letter}</span>
              <span className="grow left">
                <b className="h-md">{w.title || `Ficha ${w.letter}`}</b>
                <span className="mono tiny dim">{n} EXERCÍCIOS</span>
              </span>
              <ChevronRight size={18} />
            </button>
          )
        })}
      </div>
    )
  }

  // "trocar ficha" só tira a ficha ativa de vista — o progresso dela fica salvo
  // e retoma sozinho se o caçador escolhê-la de novo na lista
  return (
    <SessionView
      key={workout.id}
      workout={workout}
      onExit={() => setWorkoutId(null)}
      onFinishAll={() => setWorkoutId(null)}
      go={go}
    />
  )
}

// progresso da sessão (exercício atual, séries feitas, descanso, se já terminou)
// — salvo por caçador + ficha, pra sobreviver a navegar pra outra tela e voltar
const sessionStateKey = (uid, workoutId) => `rankzero_session_state_${uid}_${workoutId}`
const loadSessionState = (key) => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function SessionView({ workout, onExit, onFinishAll, go }) {
  const { user, profile, refreshProfile, awardXp, notify } = useSession()
  const stateKey = sessionStateKey(user.id, workout.id)
  const saved = useMemo(() => loadSessionState(stateKey), [stateKey])

  const now = useNow(500)
  const baseExercises = useMemo(() => flatExercises(workout), [workout])
  // ordem da sessão: começa na ordem da ficha e muda quando o caçador pula um
  // exercício (máquina ocupada) — o pulado vai pro fim da fila e volta depois.
  // Reconcilia com a ficha atual caso ela tenha sido editada no meio do treino.
  const [order, setOrder] = useState(() => {
    const ids = baseExercises.map((e) => e.id)
    const kept = (saved?.order || []).filter((id) => ids.includes(id))
    return [...kept, ...ids.filter((id) => !kept.includes(id))]
  })
  const [skipped, setSkipped] = useState(saved?.skipped ?? {})
  const exercises = useMemo(() => {
    const byId = Object.fromEntries(baseExercises.map((e) => [e.id, e]))
    return order.map((id) => byId[id]).filter(Boolean)
  }, [order, baseExercises])
  const [idx, setIdx] = useState(Math.min(saved?.idx ?? 0, Math.max(baseExercises.length - 1, 0)))
  const [done, setDone] = useState(saved?.done ?? {}) // exerciseId -> [{weight, reps, dmg}]
  const [saving, setSaving] = useState(false)
  const [restEnd, setRestEnd] = useState(saved?.restEnd ?? 0)
  const [finished, setFinished] = useState(saved?.finished ?? false)
  const startedAt = useRef(saved?.startedAt ?? Date.now())
  const [boss, setBoss] = useState(null)

  // persiste a sessão a cada mudança relevante, pra retomar de onde parou
  // se o caçador sair da tela (tela inicial, ficha, etc.) e voltar depois
  useEffect(() => {
    localStorage.setItem(stateKey, JSON.stringify({ idx, done, restEnd, finished, order, skipped, startedAt: startedAt.current }))
  }, [stateKey, idx, done, restEnd, finished, order, skipped])

  const clearSession = () => {
    try { localStorage.removeItem(stateKey) } catch { }
  }

  const ex = exercises[idx]
  const sets = done[ex?.id] || []
  const isCardio = ex?.kind === 'cardio'
  const isCardioLivre = ex?.kind === 'cardio_livre'
  const isIsometria = ex?.kind === 'isometria'

  const timerKey = ex ? `cardio_timer_${ex.id}` : null
  const [timer, setTimer] = useState(null) // regressivo: { endAt, running, remainingMs }
  const autoCompletedRef = useRef(false)

  // cronômetro livre (caminhada/corrida ao ar livre): conta PRA CIMA a partir
  // de 0, sem meta fixa — inicia, conta e só encerra quando o caçador manda,
  // e ao parar salva o tempo decorrido como duration_min da sessão
  const stopwatchKey = ex ? `cardio_stopwatch_${ex.id}` : null
  const [stopwatch, setStopwatch] = useState(null) // { startedAt, running, elapsedMs }

  // carrega/recarrega o timer salvo sempre que troca de exercício
  useEffect(() => {
    autoCompletedRef.current = false
    if (!timerKey) { setTimer(null); setStopwatch(null); return }
    const raw = localStorage.getItem(timerKey)
    setTimer(raw ? JSON.parse(raw) : null)
    const rawSw = localStorage.getItem(stopwatchKey)
    setStopwatch(rawSw ? JSON.parse(rawSw) : null)
  }, [timerKey, stopwatchKey])

  const saveTimer = (t) => {
    setTimer(t)
    if (!timerKey) return
    if (t) localStorage.setItem(timerKey, JSON.stringify(t))
    else localStorage.removeItem(timerKey)
  }

  const saveStopwatch = (s) => {
    setStopwatch(s)
    if (!stopwatchKey) return
    if (s) localStorage.setItem(stopwatchKey, JSON.stringify(s))
    else localStorage.removeItem(stopwatchKey)
  }

  const startTimer = () => {
    saveTimer({ endAt: Date.now() + targetMinutes * 60000, running: true, remainingMs: null })
  }
  const pauseTimer = () => {
    if (!timer?.running) return
    saveTimer({ ...timer, running: false, remainingMs: Math.max(0, timer.endAt - Date.now()) })
  }
  const resumeTimer = () => {
    if (timer?.running) return
    saveTimer({ endAt: Date.now() + (timer.remainingMs || 0), running: true, remainingMs: null })
  }
  const cancelTimer = () => saveTimer(null)

  const startStopwatch = () => {
    saveStopwatch({ startedAt: Date.now(), running: true, elapsedMs: 0 })
  }
  const pauseStopwatch = () => {
    if (!stopwatch?.running) return
    saveStopwatch({ ...stopwatch, running: false, elapsedMs: Date.now() - stopwatch.startedAt })
  }
  const resumeStopwatch = () => {
    if (stopwatch?.running) return
    saveStopwatch({ startedAt: Date.now() - (stopwatch.elapsedMs || 0), running: true, elapsedMs: stopwatch.elapsedMs })
  }
  const cancelStopwatch = () => saveStopwatch(null)

  const stopwatchElapsedMs = stopwatch ? (stopwatch.running ? Date.now() - stopwatch.startedAt : stopwatch.elapsedMs) : 0

  // "Parar": encerra o cronômetro livre e grava o tempo feito como a sessão
  const stopStopwatch = () => {
    const ms = stopwatch ? (stopwatch.running ? Date.now() - stopwatch.startedAt : stopwatch.elapsedMs) : 0
    cancelStopwatch()
    complete({ minutesOverride: ms / 60000 })
  }

  const timerRemainingMs = timer ? (timer.running ? Math.max(0, timer.endAt - now) : timer.remainingMs) : 0
  const timerDone = timer && timer.running && timerRemainingMs <= 0

  useEffect(() => {
    if (timerDone && !autoCompletedRef.current && !saving) {
      autoCompletedRef.current = true
      cancelTimer()
      complete()
    }
  }, [timerDone, saving])
  // boss ativo para mostrar HP e detectar vitória
  useEffect(() => {
    getBoss(user.id).then(setBoss).catch(() => { })
  }, [user.id])

  // raid em dupla: quando a raid ativa tem um amigo convidado, mostra os dois
  // caçadores e o dano de cada um contra o chefe
  const [raidMembers, setRaidMembers] = useState(null)
  useEffect(() => {
    if (!boss || boss.status !== 'active') { setRaidMembers(null); return }
    let cancelled = false
    getRaidDamageByMember(boss.id)
      .then((rows) => { if (!cancelled) setRaidMembers(rows.length > 1 ? rows : null) })
      .catch(() => { if (!cancelled) setRaidMembers(null) })
    return () => { cancelled = true }
  }, [boss?.id, boss?.status, boss?.current_hp])

  const [buddies, setBuddies] = useState([])
  useEffect(() => { getTrainingBuddies(user.id).then(setBuddies).catch(() => { }) }, [user.id])

  const [daily, setDaily] = useState(null)

  // se o boss ativo hoje É o mini-boss do marco de 15 dias, ele substitui o monstro diário
  const isMiniBossDay = boss && boss.status === 'active' && boss.name?.startsWith('SENTINELA DO MARCO')

  useEffect(() => {
    if (boss === null) return // ainda não sabemos se tem mini-boss hoje, espera
    if (isMiniBossDay) {
      setDaily(null)
      return
    }
    getDailyMonster(user.id, profile.level).then(setDaily).catch(() => { })
  }, [user.id, isMiniBossDay, boss])

  // Sair da dungeon diária: desiste do monstro do dia sem derrotá-lo, ele some
  // pelo resto do dia e um novo nasce amanhã. Só o monstro diário tem essa opção —
  // o Boss Quinzenal e o de Campanha (90 dias) são cooperativos/globais, então o
  // caçador fica "preso" neles até o fim do ciclo (não há o que abandonar sozinho).
  const [leavingDaily, setLeavingDaily] = useState(false)
  const leaveDaily = async () => {
    if (!daily) return
    setLeavingDaily(true)
    try {
      await abandonDailyMonster(daily.id)
      setDaily((d) => (d ? { ...d, status: 'abandoned' } : d))
      notify('VOCÊ SAIU DA DUNGEON DIÁRIA')
    } catch (e) {
      notify(`Não foi possível sair: ${e.message}`, 'red')
    } finally {
      setLeavingDaily(false)
    }
  }

  const [globalBoss, setGlobalBoss] = useState(null)

  useEffect(() => {
    getGlobalBoss().then(setGlobalBoss).catch(() => { })
  }, [])

  // histórico: último dia anterior em que este exercício foi feito (apenas exibição)
  const hist = useQuery(async () => {
    if (!ex) return []
    const rows = must(
      await supabase
        .from('weight_logs')
        .select('weight, reps, duration_min, logged_at')
        .eq('exercise_id', ex.id)
        .order('logged_at', { ascending: false })
        .limit(40)
    )
    const today = localDate()
    const past = rows.filter((r) => localDate(new Date(r.logged_at)) !== today)
    if (!past.length) return []
    const day = localDate(new Date(past[0].logged_at))
    return past.filter((r) => localDate(new Date(r.logged_at)) === day).reverse()
  }, [ex?.id])
  const prev = hist.data || []

  // meta cadastrada na Ficha — é o que sempre será registrado, sem edição aqui
  const targetMinutes = Number(ex?.target_minutes) > 0 ? Number(ex.target_minutes) : 20
  const targetWeight = Number(ex?.target_weight) > 0 ? Number(ex.target_weight) : 0
  const targetReps = Number(ex?.target_reps) > 0 ? Number(ex.target_reps) : 10

  const sessionDmg = Object.values(done).flat().reduce((s, r) => s + r.dmg, 0)
  const sessionSets = Object.values(done).flat().length
  const sessionXp = Object.values(done).flat().reduce((s, r) => s + xpOf(r.dmg), 0)
  const restLeft = Math.max(0, restEnd - now)
  const rows = (isCardio || isCardioLivre) ? Math.max(prev.length, sets.length + 1, 1) : Math.max(prev.length, sets.length + 1, ex?.target_sets || 3)
  const previewDmg = isCardioLivre ? damageOfMinutes(stopwatchElapsedMs / 60000) : isCardio ? damageOfMinutes(targetMinutes) : damageOf(targetWeight, targetReps)
  const setsComplete = !isCardio && !isCardioLivre && sets.length >= (ex?.target_sets || 3)

  const complete = async ({ minutesOverride } = {}) => {
    if (isCardio) cancelTimer()
    let row
    let dmg
    let entry
    if (isCardioLivre) {
      // caminhada/corrida ao ar livre: sem meta — o tempo gravado é o que o
      // cronômetro livre mediu (mínimo de 0.1 min pra evitar sessão de 0 dano)
      const mins = Math.max(0.1, Number(minutesOverride) || 0)
      row = { exercise_id: ex.id, weight: 0, reps: 0, duration_min: mins }
      dmg = damageOfMinutes(mins)
      entry = { minutes: mins, dmg }
    } else if (isCardio) {

      row = { exercise_id: ex.id, weight: 0, reps: 0, duration_min: targetMinutes }
      dmg = damageOfMinutes(targetMinutes)
      entry = { minutes: targetMinutes, dmg }
    } else if (isIsometria) {
      row = { exercise_id: ex.id, weight: 0, reps: targetReps, duration_min: targetMinutes }
      dmg = damageOfMinutes(targetMinutes) // ou uma fórmula própria
      entry = { minutes: targetMinutes, reps: targetReps, dmg }
    } else {
      row = { exercise_id: ex.id, weight: targetWeight, reps: targetReps }
      dmg = damageOf(targetWeight, targetReps)
      entry = { weight: targetWeight, reps: targetReps, dmg }
    }
    setSaving(true)
    const levelBefore = profile.level
    const { data: log, error } = await supabase.from('weight_logs').insert(row).select().single()
    if (error) {
      setSaving(false)
      return notify(`Não foi possível registrar: ${error.message}`, 'red')
    }
    setDone((d) => ({ ...d, [ex.id]: [...(d[ex.id] || []), { id: log.id, ...entry }] }))
    setRestEnd(Date.now() + getRestSeconds() * 1000)

    // o trigger do banco já aplicou XP/dano; sincroniza o estado local
    const fresh = await refreshProfile()
    if (fresh && fresh.level > levelBefore) {
      notify(`NÍVEL ${fresh.level} ALCANÇADO · +${(fresh.level - levelBefore) * 3} PONTOS`, 'gold')
      levelUnlocks(levelBefore, fresh.level).forEach((m) => notify(m, 'gold'))
    }
    if (boss && boss.status === 'active') {
      const after = await getBoss(user.id)
      setBoss(after)
      if (after && after.id === boss.id && after.status === 'defeated') {
        notify(`${after.name} FOI DERROTADO!`, 'gold')
        await awardXp(after.reward_xp)
      }
    }
    if (globalBoss && globalBoss.status === 'active') {
      await hitGlobalBoss(user.id, dmg)
      const freshGlobal = await getGlobalBoss()
      setGlobalBoss(freshGlobal)
      if (freshGlobal === null || freshGlobal.status === 'defeated') {
        notify(`${globalBoss.name} FOI DERROTADO PELA COMUNIDADE!`, 'gold')
      }
    }
    if (daily && daily.status === 'active') {
      const { data: freshDaily } = await supabase
        .from('daily_monsters')
        .select('*')
        .eq('id', daily.id)
        .maybeSingle()
      if (freshDaily) {
        setDaily(freshDaily)
        if (freshDaily.status === 'defeated' && daily.status !== 'defeated') {
          notify(`${freshDaily.name} DERROTADO! +50 XP`, 'gold')
          await awardXp(50)
        }
      }

    }
    setSaving(false)
  }

  if (finished) {
    const mins = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000))
    const pending = exercises.filter((e) => !isExerciseDone(e, done)).length
    return (
      <div className="stack">
        <Panel brackets tone="gold">
          <SysHead right="MISSÃO CUMPRIDA">[RELATÓRIO]</SysHead>
          <h2 className="h-xl glow">{workout.title || `Ficha ${workout.letter}`} concluída</h2>
          <div className="grid3">
            <div className="reward"><b>{fmt(sessionDmg)}</b><span className="mono tiny dim">DANO (KG)</span></div>
            <div className="reward"><b>{sessionSets}</b><span className="mono tiny dim">SÉRIES</span></div>
            <div className="reward"><b>{mins} min</b><span className="mono tiny dim">DURAÇÃO</span></div>
          </div>
          <p className="mono gold">+{fmt(sessionXp)} XP GRAVADO</p>
          {pending > 0 && <p className="mono tiny dim">{pending} exercício(s) ficaram de fora hoje.</p>}
        </Panel>
        <Btn onClick={() => { clearSession(); onFinishAll ? onFinishAll() : onExit(); go('inicio') }}>Voltar ao início</Btn>
        <Btn variant="ghost" onClick={() => { clearSession(); onFinishAll ? onFinishAll() : onExit() }}>Treinar outra ficha</Btn>
      </div>
    )
  }

  if (!ex) return <Empty title="Ficha vazia" action={<Btn onClick={() => go('ficha')}>Adicionar exercícios</Btn>}>Esta ficha ainda não tem exercícios.</Empty>

  const next = exercises[idx + 1]
  const isLast = !next
  const bossPct = boss ? Number(boss.current_hp) / Number(boss.max_hp) : 0
  const restActive = restLeft > 0
  const targetSets = ex.target_sets || 3
  const shownSet = Math.min(sets.length + 1, targetSets)
  const canSkip = !isLast
  const stripBoss = boss && boss.status === 'active' ? boss : null
  const stripDaily = !stripBoss && daily && daily.status === 'active' ? daily : null
  const buddyNames = buddies.map((b) => b.hunter_name || b.name).join(' e ')

  const skip = () => {
    if (!canSkip) return
    setOrder((o) => [...o.slice(0, idx), ...o.slice(idx + 1), o[idx]])
    setSkipped((m) => ({ ...m, [ex.id]: true }))
    setRestEnd(0)
    notify(`${ex.name} ficou pro final — volta quando a máquina liberar`)
  }
  const goNext = () => setIdx((i) => i + 1)
  const lastTime = prev.length
    ? (prev[0].duration_min != null ? `${fmt1(prev[prev.length - 1].duration_min)} min` : `${fmt1(prev[prev.length - 1].weight)} kg × ${prev[prev.length - 1].reps}`)
    : null
  const metaText = isCardioLivre ? 'Livre · sem tempo fixo' : isCardio ? `${targetMinutes} min` : `${targetSets} × ${targetReps}${targetWeight > 0 ? ` · ${fmt1(targetWeight)} kg` : ''}`

  return (
    <div className="fit">
      <div className="tr-top">
        <button className="link mono tiny" onClick={onExit}><ChevronLeft size={12} /> FICHAS</button>
        <div className="dots" role="tablist" aria-label="Exercícios da ficha">
          {exercises.map((e, i) => {
            const st = i === idx ? 'now' : isExerciseDone(e, done) ? 'done' : skipped[e.id] ? 'skip' : ''
            return <button key={e.id} className={`dot-ex ${st}`} onClick={() => setIdx(i)} aria-label={`${i + 1}: ${e.name}`} aria-current={i === idx} />
          })}
        </div>
        <span className="mono tiny dim">{idx + 1}/{exercises.length}</span>
      </div>

      {(stripBoss || stripDaily || buddies.length > 0) && (
        <div className="tr-strip">
          {stripBoss && (
            <div className="strip-line">
              <Chip tone="red">{raidMembers ? 'RAID DUPLA' : 'RAID'}</Chip>
              <b className="clip">{stripBoss.name}</b>
              <span className="mono tiny dim">{Math.round(bossPct * 100)}%</span>
            </div>
          )}
          {stripDaily && (
            <div className="strip-line">
              <Chip tone="amber">DIA</Chip>
              <b className="clip">{stripDaily.name}</b>
              <span className="mono tiny dim">{Math.round((Number(stripDaily.current_hp) / Number(stripDaily.max_hp)) * 100)}%</span>
              <button className="icon-btn plain" disabled={leavingDaily} onClick={leaveDaily} aria-label="Sair da dungeon diária" title="Sair da dungeon diária"><X size={14} /></button>
            </div>
          )}
          {(stripBoss || stripDaily) && (
            <SegBar value={Number((stripBoss || stripDaily).current_hp)} max={Number((stripBoss || stripDaily).max_hp)} tone={stripBoss ? 'gold' : 'amber'} segments={20} label="HP" />
          )}
          {stripBoss && raidMembers && (
            <p className="mono tiny dim clip">
              {raidMembers.map((m) => `${m.userId === user.id ? 'VOCÊ' : (m.profile?.hunter_name || m.profile?.name || 'Caçador')} ${fmt(m.damage)}`).join('  ·  ')}
            </p>
          )}
          {buddies.length > 0 && (
            <p className="mono tiny gold clip"><Users size={11} style={{ verticalAlign: '-2px' }} /> TREINANDO JUNTO COM {buddyNames.toUpperCase()}</p>
          )}
        </div>
      )}

      <Panel brackets className="tr-card">
        <div className="tr-head">
          <p className="mono tiny cyan clip">[{ex.machine}]{skipped[ex.id] && sets.length === 0 ? ' · PULADO ANTES' : ''}</p>
          <h2 className="tr-name">{ex.name}</h2>
          <p className="mono tiny dim">META {metaText}{lastTime ? ` · ÚLTIMA ${lastTime}` : ''} · <span className="gold">+{xpOf(previewDmg)} XP</span></p>
        </div>

        {!(isCardio || isCardioLivre) && (
          <div className="set-pips" aria-label={`Séries: ${sets.length} de ${targetSets}`}>
            {Array.from({ length: Math.max(targetSets, sets.length) }, (_, i) => {
              const d = sets[i]
              const active = i === sets.length && !setsComplete
              return (
                <div key={i} className={`set-pip ${d ? 'done' : ''} ${active ? 'active' : ''}`}>
                  <span className="mono tiny">SÉRIE {i + 1}</span>
                  <b>{d ? `${fmt1(d.weight)}×${d.reps}` : active ? `${fmt1(targetWeight)}×${targetReps}` : '—'}</b>
                </div>
              )
            })}
          </div>
        )}

        <div className={`rest ${restActive ? 'on' : ''}`}>
          <Timer size={18} className="gold" />
          <div className="grow">
            <p className="mono tiny dim">{restActive ? 'DESCANSO' : 'PRONTO PRA PRÓXIMA'}</p>
            <p className="timer-num">{restActive ? clock(restLeft).slice(3) : '00:00'}</p>
          </div>
          {restActive && (
            <>
              <button className="chip chip-slate mono" onClick={() => setRestEnd((e) => e + 30000)}>+30s</button>
              <button className="icon-btn" onClick={() => setRestEnd(0)} aria-label="Pular descanso"><SkipForward size={16} /></button>
            </>
          )}
        </div>

        <div className="tr-cta">
          {isCardioLivre ? (
            <>
              <div className="rest on">
                <Timer size={18} className="cyan" />
                <div className="grow">
                  <p className="mono tiny dim">{stopwatch ? (stopwatch.running ? 'CRONÔMETRO ATIVO' : 'PAUSADO') : 'PARADO'}</p>
                  <p className="timer-num">{clock(stopwatchElapsedMs)}</p>
                </div>
              </div>
              {!stopwatch && <Btn icon={Swords} className="cta" disabled={saving || restActive} onClick={startStopwatch}>Iniciar</Btn>}
              {stopwatch && (
                <div className="row gap">
                  {stopwatch.running ? <Btn variant="ghost" onClick={pauseStopwatch}>Pausar</Btn> : <Btn onClick={resumeStopwatch}>Retomar</Btn>}
                  <Btn variant="danger" onClick={stopStopwatch} disabled={saving}>{saving ? 'Gravando...' : 'Parar & registrar'}</Btn>
                </div>
              )}
            </>
          ) : isCardio ? (
            <>
              {timer && (
                <div className="rest on">
                  <Timer size={18} className="cyan" />
                  <div className="grow">
                    <p className="mono tiny dim">{timer.running ? 'CRONÔMETRO ATIVO' : 'PAUSADO'}</p>
                    <p className="timer-num">{clock(timerRemainingMs)}</p>
                  </div>
                </div>
              )}
              {!timer && <Btn icon={Swords} className="cta" disabled={saving || restActive} onClick={startTimer}>Começar cardio ({targetMinutes} min)</Btn>}
              {timer && (
                <div className="row gap">
                  {timer.running ? <Btn variant="ghost" onClick={pauseTimer}>Pausar</Btn> : <Btn onClick={resumeTimer}>Retomar</Btn>}
                  <Btn variant="danger" onClick={cancelTimer}>Cancelar</Btn>
                </div>
              )}
            </>
          ) : setsComplete ? (
            <Btn icon={isLast ? undefined : ArrowRight} className="cta" onClick={isLast ? () => setFinished(true) : goNext}>
              {isLast ? 'Finalizar treino' : 'Próximo exercício'}
            </Btn>
          ) : (
            <Btn icon={Swords} className="cta" disabled={saving || restActive} onClick={complete}>
              {saving ? 'Gravando...' : restActive ? 'Descansando...' : `Concluir série ${shownSet}`}
            </Btn>
          )}
        </div>
      </Panel>

      <div className="tr-actions">
        <Btn variant="ghost" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)} aria-label="Exercício anterior"><ChevronLeft size={18} /></Btn>
        <Btn variant="ghost" icon={FastForward} disabled={!canSkip} onClick={skip} title="Máquina ocupada? Deixa este pro final">
          <span className="skip-label"><b>Pular exercício</b><small className="mono">MÁQUINA OCUPADA</small></span>
        </Btn>
        {isLast ? (
          <Btn variant="ghost" onClick={() => setFinished(true)}>Encerrar</Btn>
        ) : (
          <Btn variant="ghost" onClick={goNext} aria-label="Próximo exercício"><ChevronRight size={18} /></Btn>
        )}
      </div>
    </div>
  )
}

// exercício concluído: séries completas (força) ou ao menos uma sessão (cardio)
function isExerciseDone(e, done) {
  const n = (done[e.id] || []).length
  return e.kind === 'cardio' || e.kind === 'cardio_livre' ? n > 0 : n >= (e.target_sets || 3)
}
