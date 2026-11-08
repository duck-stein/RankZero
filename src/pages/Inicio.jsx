import { Check, Skull, Swords, Timer } from 'lucide-react'
import { useSession } from '../context/SessionContext'
import { useNow, useQuery } from '../lib/useQuery'
import { getBoss, getMissions } from '../lib/data'
import { CLASSES, clock, endOfToday, fmt, localDate, xpToNext } from '../lib/rpg'
import { BigStat, Btn, Chip, Panel, SegBar } from '../components/ui'

// A trilha segue o ciclo de 15 dias de treino (o mesmo marco do mini-boss):
// 3 fileiras de 5 dias em "S", o último nó é o mini-boss do marco.
const CYCLE = 15
const COLS = [10, 30, 50, 70, 90]
const ROWS = [18, 50, 82]
const NODES = Array.from({ length: CYCLE }, (_, i) => {
  const row = Math.floor(i / 5)
  const col = i % 5
  return { n: i + 1, x: row % 2 === 0 ? COLS[col] : COLS[4 - col], y: ROWS[row] }
})

// caminho que liga os nós; nas pontas das fileiras faz uma curva pra fora
function pathUntil(count) {
  const pts = NODES.slice(0, Math.max(count, 1))
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (a.y !== b.y) {
      const out = a.x > 50 ? a.x + 12 : a.x - 12
      d += ` C ${out} ${a.y} ${out} ${b.y} ${b.x} ${b.y}`
    } else {
      d += ` L ${b.x} ${b.y}`
    }
  }
  return d
}

export default function Inicio({ go }) {
  const { profile: p, user } = useSession()
  const now = useNow()
  const missions = useQuery(() => getMissions(user.id), [user.id])
  const boss = useQuery(() => getBoss(user.id), [user.id])

  const need = xpToNext(p.level)
  const cls = CLASSES[p.class] || CLASSES.colosso
  const list = missions.data || []
  const doneM = list.filter((m) => m.completed).length
  const b = boss.data
  const bossActive = b && b.status === 'active'

  const checkins = p.total_checkins || 0
  const trainedToday = p.last_checkin_date === localDate()
  let c = checkins % CYCLE
  if (c === 0 && checkins > 0 && trainedToday) c = CYCLE
  const todayN = !trainedToday && c < CYCLE ? c + 1 : null
  const left = CYCLE - c

  const nodeState = (n) => (n <= c ? 'done' : n === todayN ? 'today' : 'ahead')
  const tapNode = (n) => {
    if (n === CYCLE) return go('raid')
    if (n === todayN) return go('treinar')
  }

  return (
    <div className="fit">
      <Panel>
        <div className="row between end">
          <div className="grow">
            <div className="row gap wrap">
              <Chip tone="violet">{cls.short}</Chip>
              {p.title && <Chip tone="gold">{p.title}</Chip>}
            </div>
            <p className="mono tiny dim" style={{ marginTop: 4 }}>{fmt(p.xp)} / {fmt(need)} EXP</p>
          </div>
          <BigStat value={p.level} unit="LVL" />
        </div>
        <SegBar value={p.xp} max={need} segments={20} label="Experiência" />
      </Panel>

      <div className="grid2">
        <button className="panel pick" onClick={() => go('missoes')}>
          <Timer size={18} className="cyan" />
          <span className="grow left">
            <b className="h-md">Missões {list.length ? `${doneM}/${list.length}` : ''}</b>
            <span className="mono tiny dim">PUNIÇÃO {clock(endOfToday() - now).slice(0, 5)}</span>
          </span>
        </button>
        <button className="panel pick" onClick={() => go('raid')}>
          <Skull size={18} className={bossActive ? 'red' : 'dim'} />
          <span className="grow left">
            <b className="h-md clip">{bossActive ? `${Math.round((Number(b.current_hp) / Number(b.max_hp)) * 100)}% HP` : 'Raid'}</b>
            <span className="mono tiny dim clip">{bossActive ? b.name : 'INVOCAR'}</span>
          </span>
        </button>
      </div>

      <div className="trail-wrap">
        <div className="row between">
          <span className="mono tiny cyan">TRILHA · DIA {Math.min(c + (todayN ? 1 : 0), CYCLE)}/{CYCLE}</span>
          <span className="mono tiny dim">{left === 0 ? 'MINI-BOSS LIBERADO' : `${left} ${left === 1 ? 'DIA' : 'DIAS'} PRO MINI-BOSS`}</span>
        </div>
        <div className="trail">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <path d={pathUntil(CYCLE)} className="trail-path" vectorEffect="non-scaling-stroke" />
            {c > 1 && <path d={pathUntil(c)} className="trail-path done" vectorEffect="non-scaling-stroke" />}
          </svg>
          {NODES.map(({ n, x, y }) => {
            const st = nodeState(n)
            const isBoss = n === CYCLE
            const Icon = isBoss ? Skull : st === 'done' ? Check : st === 'today' ? Swords : null
            return (
              <button
                key={n}
                className={`node ${st} ${isBoss ? 'boss' : ''}`}
                style={{ left: `${x}%`, top: `${y}%` }}
                onClick={() => tapNode(n)}
                disabled={st === 'ahead' && !isBoss}
                aria-label={isBoss ? 'Mini-boss do marco' : `Dia ${n}: ${st === 'done' ? 'feito' : st === 'today' ? 'treinar hoje' : 'bloqueado'}`}
              >
                {Icon ? <Icon size={isBoss ? 26 : 24} strokeWidth={3} /> : n}
              </button>
            )
          })}
          {todayN && (() => {
            const t = NODES[todayN - 1]
            return <span className="node-tip" style={{ left: `${t.x}%`, top: `${t.y}%` }}>TREINAR</span>
          })()}
        </div>
      </div>

      <Btn icon={Swords} className="cta" onClick={() => go('treinar')}>
        {trainedToday ? 'Treino de hoje feito · treinar mais' : 'Treinar agora'}
      </Btn>
    </div>
  )
}
