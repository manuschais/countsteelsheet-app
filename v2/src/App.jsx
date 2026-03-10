import { useRef, useState, useCallback, useEffect } from 'react'

/* ─── tiny design tokens ─────────────────────────────────────────── */
const C = {
  bg:      '#0f172a',
  surface: '#1e293b',
  border:  '#334155',
  accent:  '#60a5fa',
  accent2: '#818cf8',
  muted:   '#94a3b8',
  orange:  '#f97316',
  teal:    '#0891b2',
  red:     '#ef4444',
  green:   '#4ade80',
}

/* ─── small UI primitives ────────────────────────────────────────── */
function Btn({ children, onClick, active, color = C.accent, disabled, style = {} }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '9px 18px', border: 'none', borderRadius: 8,
    fontSize: '0.9rem', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.42 : 1,
    transition: 'opacity .15s, transform .1s',
    background: active ? color : C.surface,
    color: active ? '#fff' : C.muted,
    border: `1.5px solid ${active ? color : C.border}`,
    userSelect: 'none',
    ...style,
  }
  return <button style={base} onClick={onClick} disabled={disabled}>{children}</button>
}

function Label({ children, style = {} }) {
  return <span style={{ fontSize: '0.75rem', color: C.muted, fontWeight: 600, ...style }}>{children}</span>
}

function Slider({ label, value, min, max, step = 1, onChange, valueLabel }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Label>{label}</Label>
        <Label style={{ color: C.accent }}>{valueLabel ?? value}</Label>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: C.accent }}
      />
    </div>
  )
}

/* ─── mode definitions ───────────────────────────────────────────── */
const MODES = [
  { id: 'cv',        label: 'CV ตรวจจับเส้น' },
  { id: 'thickness', label: 'วัดจากความหนา'  },
]

/* ─── main app ───────────────────────────────────────────────────── */
export default function App() {
  /* image */
  const [imageData, setImageData]   = useState(null)   // original ImageData
  const [fileName,  setFileName]    = useState('')

  /* mode */
  const [mode, setMode]             = useState('cv')

  /* canvas geometry */
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })

  /* zoom / pan */
  const [zoom,   setZoom]   = useState(1)
  const [pan,    setPan]    = useState({ x: 0, y: 0 })

  /* manual count */
  const [manualMode,   setManualMode]   = useState(false)
  const [manualDots,   setManualDots]   = useState([])
  const [autoCount,    setAutoCount]    = useState(0)
  const [dotSize,      setDotSize]      = useState(1.0)

  /* CV result */
  const [clusters,     setClusters]     = useState([])  // [{avgY, lines, ox, removed}]
  const [badgeSize,    setBadgeSize]    = useState(1.0)
  const [showLines,    setShowLines]    = useState(false)

  /* image adjustments */
  const [brightness,   setBrightness]   = useState(0)
  const [contrast,     setContrast]     = useState(0)
  const [falseColor,   setFalseColor]   = useState(false)

  /* ROI */
  const [roi,          setRoi]          = useState(null)
  const [roiMode,      setRoiMode]      = useState(false)

  /* status */
  const [status,  setStatus]   = useState({ msg: 'โหลดภาพเพื่อเริ่มต้น', type: 'info' })
  const [result,  setResult]   = useState(null)

  /* refs */
  const canvasRef      = useRef(null)
  const hiddenFileRef  = useRef(null)
  const hiddenCamRef   = useRef(null)
  const panStartRef    = useRef(null)
  const panningRef     = useRef(false)
  const roiStartRef    = useRef(null)
  const pinchRef       = useRef(null)

  /* ── load image ── */
  const loadFile = useCallback((file) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      setImageData(data)
      setCanvasSize({ w: canvas.width, h: canvas.height })
      setFileName(file.name)
      setManualDots([])
      setAutoCount(0)
      setClusters([])
      setRoi(null)
      setResult(null)
      setZoom(1); setPan({ x: 0, y: 0 })
      setStatus({ msg: `โหลดสำเร็จ: ${canvas.width}×${canvas.height}px`, type: 'ok' })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => setStatus({ msg: 'โหลดภาพไม่สำเร็จ', type: 'error' })
    img.src = url
  }, [])

  /* ── draw loop (whenever deps change) ── */
  useEffect(() => {
    if (!imageData) return
    const canvas = canvasRef.current
    const ctx    = canvas.getContext('2d')

    /* base image with adjustments */
    if (brightness !== 0 || contrast !== 0) {
      const adj = new ImageData(canvas.width, canvas.height)
      const s = imageData.data, d = adj.data
      const c = 1 + contrast / 100
      for (let i = 0; i < s.length; i += 4) {
        for (let ch = 0; ch < 3; ch++) {
          let v = (s[i+ch] - 128) * c + 128 + brightness
          d[i+ch] = Math.max(0, Math.min(255, Math.round(v)))
        }
        d[i+3] = s[i+3]
      }
      ctx.putImageData(adj, 0, 0)
    } else {
      ctx.putImageData(imageData, 0, 0)
    }

    /* false color */
    if (falseColor) {
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const d  = id.data
      for (let i = 0; i < d.length; i += 4) {
        const g = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) / 255
        let r, gr, b
        if      (g < 0.25) { r=0;           gr=g*4*255;      b=255 }
        else if (g < 0.5)  { r=0;           gr=255;          b=(0.5-g)*4*255 }
        else if (g < 0.75) { r=(g-0.5)*4*255; gr=255;        b=0 }
        else               { r=255;         gr=(1-g)*4*255;  b=0 }
        d[i]=Math.round(r); d[i+1]=Math.round(gr); d[i+2]=Math.round(b)
      }
      ctx.putImageData(id, 0, 0)
    }

    /* ROI rect */
    if (roi) {
      ctx.save()
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = Math.max(2, canvas.width/500)
      ctx.setLineDash([10, 5])
      ctx.strokeRect(roi.x, roi.y, roi.w, roi.h)
      ctx.fillStyle = 'rgba(34,211,238,0.07)'
      ctx.fillRect(roi.x, roi.y, roi.w, roi.h)
      ctx.restore()
    }

    /* CV clusters */
    if (mode === 'cv' && clusters.length > 0) {
      const lw = Math.max(2, canvas.width/500)
      const br = Math.max(14, canvas.width/65) * badgeSize
      let visIdx = 0
      clusters.forEach(cl => {
        const lx = cl.ox + br + 4, ly = Math.round(cl.avgY)
        ctx.save()
        if (cl.removed) {
          if (showLines) {
            ctx.globalAlpha = 0.18; ctx.strokeStyle='#aaa'; ctx.lineWidth=lw
            cl.lines.forEach(l => { ctx.beginPath(); ctx.moveTo(l.x1,l.y1); ctx.lineTo(l.x2,l.y2); ctx.stroke() })
            ctx.globalAlpha = 1
          }
          ctx.fillStyle = 'rgba(150,150,150,0.45)'
          ctx.beginPath(); ctx.arc(lx,ly,br,0,Math.PI*2); ctx.fill()
          ctx.strokeStyle='#e94560'; ctx.lineWidth=Math.max(2,br*0.18)
          ctx.beginPath(); ctx.moveTo(lx-br*0.6,ly-br*0.6); ctx.lineTo(lx+br*0.6,ly+br*0.6); ctx.stroke()
        } else {
          visIdx++
          if (showLines) {
            ctx.strokeStyle='#ff3333'; ctx.lineWidth=lw
            cl.lines.forEach(l => { ctx.beginPath(); ctx.moveTo(l.x1,l.y1); ctx.lineTo(l.x2,l.y2); ctx.stroke() })
          }
          ctx.fillStyle = '#ffc800'
          ctx.beginPath(); ctx.arc(lx,ly,br,0,Math.PI*2); ctx.fill()
          ctx.fillStyle='#000'; ctx.font=`bold ${Math.round(br*1.05)}px sans-serif`
          ctx.textAlign='center'; ctx.textBaseline='middle'
          ctx.fillText(String(visIdx), lx, ly)
        }
        ctx.restore()
      })
    }

    /* manual dots */
    manualDots.forEach(d => {
      const r = Math.max(14, canvas.width/65) * dotSize
      ctx.save()
      ctx.fillStyle = C.orange
      ctx.beginPath(); ctx.arc(d.cx, d.cy, r, 0, Math.PI*2); ctx.fill()
      ctx.strokeStyle='#fff'; ctx.lineWidth=Math.max(2,r*0.12); ctx.stroke()
      ctx.fillStyle='#fff'; ctx.font=`bold ${Math.round(r*1.05)}px sans-serif`
      ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText(String(d.n), d.cx, d.cy)
      ctx.restore()
    })
  }, [imageData, brightness, contrast, falseColor, roi, mode, clusters, showLines, badgeSize, manualDots, dotSize])

  /* ── canvas coord helper ── */
  const toCanvas = useCallback((clientX, clientY) => {
    const r = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.round((clientX - r.left) * canvasRef.current.width  / r.width),
      y: Math.round((clientY - r.top)  * canvasRef.current.height / r.height),
    }
  }, [])

  /* ── pointer handlers ── */
  const onPointerDown = useCallback((e) => {
    if (!imageData) return
    e.preventDefault()
    const pt = toCanvas(e.clientX, e.clientY)

    /* right-click = pan always */
    if (e.button === 2) {
      panningRef.current = true
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    /* ROI drag */
    if (roiMode) {
      roiStartRef.current = pt
      return
    }

    /* cluster badge removal */
    if (mode === 'cv' && clusters.length > 0) {
      const br = Math.max(14, canvasRef.current.width/65) * badgeSize
      const hit = clusters.find(cl => {
        const lx = cl.ox + br + 4, ly = Math.round(cl.avgY)
        return (pt.x-lx)**2 + (pt.y-ly)**2 <= br*br
      })
      if (hit) {
        const updated = clusters.map(cl =>
          cl === hit ? { ...cl, removed: !cl.removed } : cl
        )
        setClusters(updated)
        const newAuto = updated.filter(c => !c.removed).length
        setAutoCount(newAuto)
        setResult(newAuto + manualDots.length)
        return
      }
    }

    /* manual tap */
    if (manualMode) {
      const n = autoCount + manualDots.length + 1
      setManualDots(prev => [...prev, { cx: pt.x, cy: pt.y, n }])
      setResult(autoCount + manualDots.length + 1)
      return
    }

    /* left-click pan when zoomed */
    if (zoom > 1) {
      panningRef.current = true
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }, [imageData, pan, roiMode, mode, clusters, badgeSize, manualMode, autoCount, manualDots, zoom, toCanvas])

  const onPointerMove = useCallback((e) => {
    if (panningRef.current && panStartRef.current) {
      const nx = e.clientX - panStartRef.current.x
      const ny = e.clientY - panStartRef.current.y
      /* clamp */
      const wrapper = e.currentTarget.closest('.canvas-wrapper') ?? e.currentTarget.parentElement
      const maxPx = wrapper.clientWidth  * (zoom - 1) / 2
      const maxPy = wrapper.clientHeight * (zoom - 1) / 2
      setPan({
        x: Math.max(-maxPx, Math.min(maxPx, nx)),
        y: Math.max(-maxPy, Math.min(maxPy, ny)),
      })
    }
  }, [zoom])

  const onPointerUp = useCallback((e) => {
    if (panningRef.current) { panningRef.current = false; panStartRef.current = null }
  }, [])

  const onContextMenu = useCallback(e => e.preventDefault(), [])

  /* ── wheel zoom ── */
  const onWheel = useCallback((e) => {
    e.preventDefault()
    const wr  = e.currentTarget.getBoundingClientRect()
    const mx  = e.clientX - wr.left - wr.width  / 2
    const my  = e.clientY - wr.top  - wr.height / 2
    setZoom(prev => {
      const next  = Math.max(1, Math.min(6, prev * (e.deltaY > 0 ? 0.88 : 1.14)))
      const ratio = next / prev
      setPan(p => {
        const maxPx = wr.width  * (next-1)/2, maxPy = wr.height * (next-1)/2
        return {
          x: Math.max(-maxPx, Math.min(maxPx, mx*(1-ratio) + p.x*ratio)),
          y: Math.max(-maxPy, Math.min(maxPy, my*(1-ratio) + p.y*ratio)),
        }
      })
      return next
    })
  }, [])

  /* ── OpenCV processing ── */
  const processCV = useCallback(() => {
    if (typeof cv === 'undefined') {
      setStatus({ msg: 'OpenCV ยังไม่โหลด', type: 'error' }); return
    }
    if (!imageData) return

    setStatus({ msg: 'กำลังประมวลผล...', type: 'info' })
    setTimeout(() => {
      let fullSrc, procSrc, gray, blurred, edges, lines, resultMat, edgeRGBA
      try {
        const canvas = canvasRef.current
        canvas.getContext('2d').putImageData(imageData, 0, 0)
        fullSrc = cv.imread(canvas)

        let ox = 0, oy = 0
        if (roi && roi.w > 20 && roi.h > 20) {
          const rx = Math.max(0, Math.min(roi.x, fullSrc.cols-2))
          const ry = Math.max(0, Math.min(roi.y, fullSrc.rows-2))
          const rw = Math.min(roi.w, fullSrc.cols-rx)
          const rh = Math.min(roi.h, fullSrc.rows-ry)
          if (rw > 10 && rh > 10) {
            procSrc = fullSrc.roi(new cv.Rect(rx,ry,rw,rh)).clone()
            ox=rx; oy=ry
          }
        }
        if (!procSrc) procSrc = fullSrc.clone()

        gray=new cv.Mat(); blurred=new cv.Mat(); edges=new cv.Mat()
        cv.cvtColor(procSrc, gray, cv.COLOR_RGBA2GRAY)
        cv.GaussianBlur(gray, blurred, new cv.Size(5,5), 0)
        cv.Canny(blurred, edges, 50, 150)

        lines = new cv.Mat()
        const refW = roi ? Math.min(roi.w, procSrc.cols) : canvas.width
        cv.HoughLinesP(edges, lines, 1, Math.PI/180, 40, refW*0.25, 20)

        const horiz = []
        for (let i = 0; i < lines.rows; i++) {
          const x1=lines.data32S[i*4]+ox, y1=lines.data32S[i*4+1]+oy
          const x2=lines.data32S[i*4+2]+ox, y2=lines.data32S[i*4+3]+oy
          const ang = Math.abs(Math.atan2(y2-y1,x2-x1)*180/Math.PI)
          if (ang<15||ang>165) horiz.push({x1,y1,x2,y2,midY:(y1+y2)/2})
        }
        horiz.sort((a,b)=>a.midY-b.midY)

        const clusterList = []
        for (const ln of horiz) {
          const last = clusterList[clusterList.length-1]
          if (!last || ln.midY-last.avgY > 20) {
            clusterList.push({ lines:[ln], avgY:ln.midY })
          } else {
            last.lines.push(ln)
            last.avgY = last.lines.reduce((s,l)=>s+l.midY,0)/last.lines.length
          }
        }

        const newClusters = clusterList.map(cl => ({
          lines: cl.lines.map(l=>({x1:l.x1,y1:l.y1,x2:l.x2,y2:l.y2})),
          avgY:  cl.avgY, ox, removed: false,
        }))
        setClusters(newClusters)
        setAutoCount(newClusters.length)
        setManualDots([])
        setResult(newClusters.length)
        setStatus({ msg: `ตรวจพบ ${newClusters.length} กลุ่มเส้น จาก ${horiz.length} เส้น`, type: 'ok' })
      } catch(err) {
        setStatus({ msg: 'เกิดข้อผิดพลาด: '+err.message, type: 'error' })
      } finally {
        [fullSrc,procSrc,gray,blurred,edges,lines,resultMat,edgeRGBA]
          .forEach(m=>{ try{if(m&&!m.isDeleted())m.delete()}catch(_){} })
      }
    }, 50)
  }, [imageData, roi])

  const total = autoCount + manualDots.length

  /* ── render ── */
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
                  minHeight:'100%', padding:'20px 16px', gap:16 }}>

      {/* Header */}
      <header style={{ textAlign:'center' }}>
        <h1 style={{ fontSize:'1.5rem', fontWeight:800,
                     background:'linear-gradient(135deg,#60a5fa,#818cf8)',
                     WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
                     backgroundClip:'text' }}>
          ระบบนับแผ่นเหล็ก <span style={{fontSize:'0.7em',opacity:0.7}}>รุ่น 2</span>
        </h1>
        <a href="../" style={{ fontSize:'0.75rem', color:C.muted, textDecoration:'none' }}>
          ← กลับหน้าหลัก
        </a>
      </header>

      {/* Upload buttons */}
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', justifyContent:'center' }}>
        <input ref={hiddenCamRef}  type="file" accept="image/*" capture="environment"
               style={{display:'none'}} onChange={e=>loadFile(e.target.files[0])} />
        <input ref={hiddenFileRef} type="file" accept="image/*"
               style={{display:'none'}} onChange={e=>loadFile(e.target.files[0])} />

        <Btn onClick={()=>hiddenCamRef.current.click()}  style={{background:'#0f3460',color:'#fff',border:'none'}}>
          📷 ถ่ายภาพ
        </Btn>
        <Btn onClick={()=>hiddenFileRef.current.click()} style={{background:'#e94560',color:'#fff',border:'none'}}>
          ⬆️ อัปโหลด
        </Btn>
        {imageData && mode==='cv' && (
          <Btn onClick={processCV} style={{background:'#1e3a5f',color:'#93c5fd',border:'1.5px solid #1e40af'}}>
            ⚙️ ประมวลผล CV
          </Btn>
        )}
        {imageData && (
          <Btn onClick={()=>{
            setImageData(null); setClusters([]); setManualDots([])
            setAutoCount(0); setResult(null); setZoom(1); setPan({x:0,y:0})
            setStatus({msg:'รีเซ็ตแล้ว',type:'info'})
          }} style={{background:C.surface,color:C.muted}}>
            รีเซ็ต
          </Btn>
        )}
      </div>

      {/* Mode tabs */}
      <div style={{ display:'flex', width:'100%', maxWidth:720,
                    background:C.surface, borderRadius:10, overflow:'hidden',
                    border:`1px solid ${C.border}` }}>
        {MODES.map(m => (
          <button key={m.id} onClick={()=>setMode(m.id)}
            style={{ flex:1, padding:'11px 8px', border:'none', cursor:'pointer',
                     background: mode===m.id ? '#1e3a5f' : 'transparent',
                     color: mode===m.id ? C.accent : C.muted,
                     fontWeight:600, fontSize:'0.88rem',
                     borderBottom: mode===m.id ? `3px solid ${C.accent}` : '3px solid transparent',
                     transition:'all .2s' }}>
            {m.label}
          </button>
        ))}
      </div>

      {/* Canvas */}
      <div className="canvas-wrapper"
           style={{ position:'relative', width:'100%', maxWidth:720,
                    aspectRatio:'4/3', background:C.surface,
                    borderRadius:12, border:`1px solid ${C.border}`,
                    overflow:'hidden', touchAction:'none',
                    display:'flex', alignItems:'center', justifyContent:'center' }}
           onWheel={onWheel}>

        {!imageData && (
          <div style={{ color:C.muted, textAlign:'center', pointerEvents:'none' }}>
            ยังไม่มีภาพ<br/>กดถ่ายหรืออัปโหลดเพื่อเริ่มต้น
          </div>
        )}

        <div style={{
          width:'100%', height:'100%',
          display:'flex', alignItems:'center', justifyContent:'center',
          transformOrigin:'center center', willChange:'transform',
          transform: zoom===1 ? '' : `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
        }}>
          <canvas ref={canvasRef}
            style={{ display: imageData?'block':'none', maxWidth:'100%', maxHeight:'100%',
                     objectFit:'contain',
                     cursor: roiMode ? 'crosshair' : manualMode ? 'cell' : zoom>1 ? 'grab' : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={onContextMenu}
          />
        </div>

        {/* Floating toolbar */}
        {imageData && (
          <div style={{
            position:'absolute', bottom:10, left:'50%', transform:'translateX(-50%)',
            display:'flex', alignItems:'center', gap:5, padding:'6px 10px',
            background:'rgba(10,14,36,0.85)', borderRadius:32,
            backdropFilter:'blur(6px)', WebkitBackdropFilter:'blur(6px)',
            zIndex:20, flexWrap:'wrap', justifyContent:'center',
            maxWidth:'calc(100% - 16px)',
          }}>
            {/* Manual count */}
            <button onClick={()=>setManualMode(v=>!v)} style={{
              padding:'5px 11px', border:`1.5px solid ${manualMode?C.orange:'rgba(255,255,255,0.22)'}`,
              borderRadius:20, background:manualMode?C.orange:'rgba(255,255,255,0.1)',
              color: manualMode?'#fff':'#ddd', fontSize:'0.76rem', fontWeight:600, cursor:'pointer',
            }}>✏️ {manualMode?'หยุด':'นับมือ'}</button>

            <button onClick={()=>{ setManualDots(d=>{ const n=d.slice(0,-1); setResult(autoCount+n.length); return n }); }}
              disabled={manualDots.length===0}
              style={{ padding:'5px 11px', border:'1.5px solid rgba(255,255,255,0.22)',
                borderRadius:20, background:'rgba(255,255,255,0.1)', color:'#ddd',
                fontSize:'0.76rem', fontWeight:600, cursor:'pointer', opacity:manualDots.length?1:0.3 }}>↩</button>

            <button onClick={()=>{ setManualDots([]); setResult(autoCount); }}
              style={{ padding:'5px 10px', border:'1.5px solid rgba(255,255,255,0.22)',
                borderRadius:20, background:'rgba(255,255,255,0.1)', color:'#ddd',
                fontSize:'0.76rem', cursor:'pointer' }}>🗑</button>

            <div style={{width:1,height:22,background:'rgba(255,255,255,0.18)'}}/>

            <button onClick={()=>setShowLines(v=>!v)} style={{
              padding:'5px 11px', border:`1.5px solid ${showLines?C.teal:'rgba(255,255,255,0.22)'}`,
              borderRadius:20, background:showLines?C.teal:'rgba(255,255,255,0.1)',
              color:showLines?'#fff':'#ddd', fontSize:'0.76rem', fontWeight:600, cursor:'pointer',
            }}>เส้น</button>

            <button onClick={()=>setFalseColor(v=>!v)} style={{
              padding:'5px 11px', border:`1.5px solid ${falseColor?'#7c3aed':'rgba(255,255,255,0.22)'}`,
              borderRadius:20, background:falseColor?'#7c3aed':'rgba(255,255,255,0.1)',
              color:falseColor?'#fff':'#ddd', fontSize:'0.76rem', fontWeight:600, cursor:'pointer',
            }}>ย้อมสี</button>

            <div style={{width:1,height:22,background:'rgba(255,255,255,0.18)'}}/>

            {/* Badge + dot size sliders */}
            <div style={{display:'flex',alignItems:'center',gap:4}}>
              <span style={{fontSize:'0.62rem',color:'rgba(255,255,255,0.5)'}}>AUTO</span>
              <input type="range" min="0.5" max="3" step="0.1" value={badgeSize}
                onChange={e=>setBadgeSize(parseFloat(e.target.value))}
                style={{width:60,accentColor:C.orange}}/>
              <span style={{fontSize:'0.62rem',color:'rgba(255,255,255,0.5)'}}>มือ</span>
              <input type="range" min="0.4" max="3" step="0.1" value={dotSize}
                onChange={e=>setDotSize(parseFloat(e.target.value))}
                style={{width:60,accentColor:C.orange}}/>
            </div>
          </div>
        )}
      </div>

      {/* Status */}
      <div style={{
        width:'100%', maxWidth:720, padding:'9px 14px',
        background:C.surface, borderRadius:8, fontSize:'0.85rem', color:C.muted,
        borderLeft:`4px solid ${status.type==='ok'?C.green:status.type==='error'?C.red:C.accent}`,
      }}>
        {status.msg}
      </div>

      {/* Result */}
      {result !== null && (
        <div style={{ width:'100%', maxWidth:720, padding:'16px 20px', textAlign:'center',
                      background:C.surface, borderRadius:10, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:'0.82rem', color:C.muted, marginBottom:4 }}>
            จำนวนแผ่นเหล็กที่ตรวจพบ
          </div>
          <div style={{ fontSize:'3rem', fontWeight:800, color:C.accent, lineHeight:1.1 }}>
            {total}
          </div>
          {manualDots.length > 0 && (
            <div style={{ fontSize:'0.8rem', color:C.muted, marginTop:6 }}>
              AUTO <strong style={{color:C.accent}}>{autoCount}</strong>
              {' '}+ มือ <strong style={{color:C.orange}}>{manualDots.length}</strong>
              {' '}= รวม <strong style={{color:C.green}}>{total}</strong> แผ่น
            </div>
          )}
        </div>
      )}

      {/* Image adjustment */}
      {imageData && (
        <div style={{ width:'100%', maxWidth:720, padding:'14px 16px',
                      background:C.surface, borderRadius:10, border:`1px solid ${C.border}`,
                      display:'flex', gap:16, flexWrap:'wrap', alignItems:'flex-end' }}>
          <div style={{flex:1, minWidth:130}}>
            <Slider label="ความสว่าง" value={brightness} min={-100} max={100} step={5}
                    onChange={setBrightness} />
          </div>
          <div style={{flex:1, minWidth:130}}>
            <Slider label="ความคมชัด" value={contrast} min={-50} max={100} step={5}
                    onChange={setContrast} />
          </div>
          <button onClick={()=>{setBrightness(0);setContrast(0)}}
            style={{ padding:'6px 12px', border:`1.5px solid ${C.border}`, borderRadius:6,
                     background:'transparent', color:C.muted, fontSize:'0.78rem', cursor:'pointer' }}>
            รีเซ็ต
          </button>
        </div>
      )}

      {/* Zoom reset */}
      {zoom > 1 && (
        <div style={{display:'flex',gap:8}}>
          <Btn onClick={()=>{setZoom(1);setPan({x:0,y:0})}}>1:1 รีเซ็ตซูม</Btn>
        </div>
      )}

    </div>
  )
}
