import { go } from '@/routing/router'
import './notFound.css'

/** A wrong address: the 404 page as designed in public/404.html, with the way back home. */
export function NotFoundPage() {
  return (
    <div className="nf">
      <div className="nf-noise" aria-hidden />

      {/* Floating background chat bubbles */}
      <div className="nf-ghost nf-ghost-1" aria-hidden>
        Did you fall asleep on the keyboard?
      </div>
      <div className="nf-ghost nf-ghost-2" aria-hidden>
        This is why we can&rsquo;t have nice things.
      </div>
      <div className="nf-ghost nf-ghost-3" aria-hidden>
        Error 404: Brain not found.
      </div>
      <div className="nf-ghost nf-ghost-4" aria-hidden>
        Even the AI is disappointed in you.
      </div>

      <main className="nf-card">
        <div className="nf-code" aria-hidden>
          404
        </div>
        <h1>
          Well, this is <span>awkward.</span>
        </h1>
        <p>
          We looked everywhere. Behind the server, under the database, we even asked the AI—and it just replied with a
          clown emoji.
          <br />
          <br />
          Either you typed this URL with your elbows, or the page literally ran away because it saw you coming.
        </p>
        <a
          href="/"
          className="nf-home"
          onClick={(e) => {
            e.preventDefault()
            go('/')
          }}
        >
          Fine, take me back
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </a>
      </main>
    </div>
  )
}
