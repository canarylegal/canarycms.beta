import { useEffect, useState } from 'react'
import { AdminFinance } from './AdminFinance'
import { AdminEventsTemplate } from './AdminEventsTemplate'
import { apiFetch } from './api'
import type { ApiError } from './api'
import type { MatterHeadTypeOut, MatterSubTypeOut } from './types'

export function AdminSubMenus({ token }: { token: string }) {
  const [heads, setHeads] = useState<MatterHeadTypeOut[]>([])
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null)
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function loadHeads() {
    setErr(null)
    try {
      const data = await apiFetch<MatterHeadTypeOut[]>('/matter-types', { token })
      setHeads(data)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load matter types')
    }
  }

  useEffect(() => {
    void loadHeads()
  }, [token])

  useEffect(() => {
    setSelectedSubId(null)
  }, [selectedHeadId])

  const selectedHead = heads.find((h) => h.id === selectedHeadId) ?? null
  const selectedSub: MatterSubTypeOut | null =
    selectedHead?.sub_types.find((s) => s.id === selectedSubId) ?? null

  return (
    <div className="stack">
      {err ? <div className="error">{err}</div> : null}

      <div className="muted" style={{ fontSize: '0.95em', marginBottom: 8 }}>
        Select a matter sub-type to configure <strong>Events</strong> lines and the <strong>Finance</strong> template. Add
        the Events or Finance menu to a sub-type under <strong>Admin → Matters</strong> so they appear on the case page.
      </div>

      <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Head matter types</h3>
          <div className="list">
            {heads.map((h) => (
              <div
                key={h.id}
                className="listCard row"
                style={{
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  background: selectedHeadId === h.id ? 'rgba(37,99,235,0.1)' : undefined,
                }}
                onClick={() => setSelectedHeadId(h.id)}
              >
                <span className="listTitle">{h.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {h.sub_types.length} sub
                </span>
              </div>
            ))}
            {heads.length === 0 ? <div className="muted">No head types — create them under Matters.</div> : null}
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Sub types</h3>
          {!selectedHeadId ? (
            <div className="muted">Select a head type first.</div>
          ) : (
            <div className="list">
              {selectedHead!.sub_types.map((s) => (
                <div
                  key={s.id}
                  className="listCard row"
                  style={{
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    background: selectedSubId === s.id ? 'rgba(37,99,235,0.1)' : undefined,
                  }}
                  onClick={() => setSelectedSubId(s.id)}
                >
                  <span className="listTitle">{s.name}</span>
                </div>
              ))}
              {selectedHead!.sub_types.length === 0 ? (
                <div className="muted">No sub types — add them under Matters.</div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {selectedSub ? (
        <div className="stack" style={{ gap: 20 }}>
          <div className="card" style={{ padding: 16 }}>
            <AdminEventsTemplate token={token} subTypeId={selectedSub.id} subTypeName={selectedSub.name} />
          </div>
          <div className="card" style={{ padding: 16 }}>
            <AdminFinance token={token} subTypeId={selectedSub.id} subTypeName={selectedSub.name} />
          </div>
        </div>
      ) : selectedHeadId ? (
        <div className="muted">Select a sub type to edit Events and Finance templates.</div>
      ) : null}
    </div>
  )
}
