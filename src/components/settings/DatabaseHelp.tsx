import type { ReactNode } from 'react'
import type { DatabaseProblem } from '@/data/server/types'

/** What to change so the database in MONGODB_URI can be used, by kind of problem. */
export function DatabaseHelp({ problem }: { problem: DatabaseProblem | undefined }) {
  const lead = <p>If this is your site, here's what to fix:</p>
  const text = 'space-y-2 text-xs leading-relaxed text-muted'
  switch (problem) {
    case 'unreachable':
      return (
        <div className={text}>
          {lead}
          <p>
            MongoDB Atlas isn't letting this server in. In Atlas, open{' '}
            <b className="font-medium text-fg">Database &amp; Network Access → IP Access List → Add IP Address</b>, choose{' '}
            <b className="font-medium text-fg">Allow access from anywhere</b> (<Code>0.0.0.0/0</Code>), confirm, and wait
            until it says <b className="font-medium text-fg">Active</b>. A host like Render has no fixed address, so a single
            IP won't do. If the cluster is paused, resume it.
          </p>
        </div>
      )
    case 'auth':
      return (
        <div className={text}>
          {lead}
          <p>
            The database rejected the username or password in <Code>MONGODB_URI</Code>. Check them in Atlas →{' '}
            <b className="font-medium text-fg">Database &amp; Network Access → Database Users</b>. A password with punctuation
            has to be URL-encoded, so one with only letters and digits is simplest.
          </p>
        </div>
      )
    case 'not-found':
      return (
        <div className={text}>
          {lead}
          <p>
            The cluster named in <Code>MONGODB_URI</Code> doesn't exist. Copy the connection string again from Atlas (
            <b className="font-medium text-fg">Connect → Drivers</b>).
          </p>
        </div>
      )
    case 'shared':
      return (
        <div className={text}>
          {lead}
          <p>
            The database named in <Code>MONGODB_URI</Code> belongs to another app. Give Sytext its own: put a name after the
            host, like <Code>…mongodb.net/sytext?retryWrites=true</Code>.
          </p>
        </div>
      )
    default:
      return (
        <div className={text}>
          <p>If this is your site, the server's log says why. With MongoDB Atlas it's usually one of:</p>
          <ul className="list-disc space-y-1 pl-5 marker:text-faint">
            <li>
              <b className="font-medium text-fg">Network Access</b> doesn't let the server in. Add <Code>0.0.0.0/0</Code>{' '}
              there, since a host like Render has no fixed address.
            </li>
            <li>
              The cluster is <b className="font-medium text-fg">paused</b> (Clusters → Resume).
            </li>
            <li>
              <Code>MONGODB_URI</Code> names a cluster or user that no longer exists.
            </li>
          </ul>
        </div>
      )
  }
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] break-all text-fg">{children}</code>
}
