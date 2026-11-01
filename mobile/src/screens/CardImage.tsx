// A card's images on the screen: those of its description, at the width of the screen and whole
// on a tap, and its cover across the top of its face, cropped as the desktop crops it. The open
// board's loader (repo/images.ts) is handed down by `Images`, so the Markdown renderer and the
// card face find an image by the path the card names alone. One the phone can't show (not in the
// repo, or not read yet and offline) shows its path in the description, as on the desktop, and
// leaves the face as it is without a cover.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isRelativeImage } from '@shared/images'
import type { Session } from '../github/session'
import type { Snapshot } from '../repo/cache'
import { ImageCache, ImageLoader, indexedDbImages } from '../repo/images'
import './CardImage.css'

const cache = new ImageCache(indexedDbImages())

const Context = createContext<{ loader?: ImageLoader; board?: string }>({})

/** Hands the open repo's images down to the screens, for the cards of `board`. */
export function Images(props: { api?: Session['api']; snapshot?: Snapshot; board?: string; children: ReactNode }) {
  const { api, snapshot, board, children } = props
  const loader = useMemo(() => (snapshot ? new ImageLoader(cache, snapshot, api) : undefined), [api, snapshot])
  const value = useMemo(() => ({ loader, board }), [loader, board])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

type Shown = { url: string } | { missing: 'loading' | 'absent' | 'offline' | 'failed' }

/** An image a card names, as an object URL while it's on screen. */
function useCardImage(src: string): Shown {
  const { loader, board } = useContext(Context)
  const [shown, setShown] = useState<Shown>({ missing: 'loading' })
  useEffect(() => {
    if (!loader || board === undefined) return setShown({ missing: 'offline' })
    let url: string | undefined
    let live = true
    setShown({ missing: 'loading' })
    loader.load(board, src).then(
      answer => {
        if (!live) return
        if ('missing' in answer) return setShown({ missing: answer.missing })
        url = URL.createObjectURL(new Blob([answer.image.bytes as BlobPart], { type: answer.image.type }))
        setShown({ url })
      },
      () => live && setShown({ missing: 'failed' }),
    )
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [loader, board, src])
  return shown
}

const WHY = {
  loading: 'Reading the image…',
  absent: 'Image not in the board repo',
  offline: 'Image not on the phone yet',
  failed: 'Couldn’t read the image',
}

/** An image of the description: the screen's width, and the whole of it on a tap. */
export function CardImage({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null
  // A picture from the web, as the desktop shows one; anything else that isn't the repo's, nothing.
  if (!isRelativeImage(src)) return /^https?:\/\//.test(src) ? <Zoomable url={src} alt={alt} /> : null
  return <RepoImage src={src} alt={alt} />
}

function RepoImage({ src, alt }: { src: string; alt?: string }) {
  const shown = useCardImage(src)
  if ('url' in shown) return <Zoomable url={shown.url} alt={alt} />
  return (
    <span className={`image-missing${shown.missing === 'loading' ? ' loading' : ''}`}>
      {WHY[shown.missing]}: <code>{src}</code>
    </span>
  )
}

function Zoomable({ url, alt }: { url: string; alt?: string }) {
  const [whole, setWhole] = useState(false)
  return (
    <>
      <img className="card-image" src={url} alt={alt ?? ''} onClick={() => setWhole(true)} />
      {whole &&
        createPortal(
          <div className="image-whole" role="dialog" aria-label={alt || 'Image'} onClick={() => setWhole(false)}>
            <img src={url} alt={alt ?? ''} />
          </div>,
          document.body,
        )}
    </>
  )
}

/** The card's cover across the top of its face; nothing while it isn't here. */
export function CardCover({ src }: { src: string }) {
  const shown = useCardImage(src)
  return 'url' in shown ? <img className="card-cover" src={shown.url} alt="" /> : null
}
