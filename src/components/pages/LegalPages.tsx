import { PublicPage, Section } from './PublicPage'

/**
 * The terms and the privacy policy. They describe what Sytext actually does, so they stay true as
 * the app changes; anything a lawyer wants to add goes here.
 */

export function TermsPage() {
  return (
    <PublicPage title="Terms and conditions" lead="The short version: it's your account, your chats, and your responsibility to use the networks you link within their own rules.">
      <Section title="What Sytext is">
        <p>
          Sytext brings the chats of accounts you link — WhatsApp, Telegram, Instagram and others — into one inbox. It acts as you, with
          your permission, on networks you already belong to. It is not affiliated with any of them.
        </p>
      </Section>
      <Section title="Your account">
        <p>
          You are responsible for what is sent from your account, for keeping your password and recovery key safe, and for having the
          right to use the accounts you link. You can delete your Sytext account at any time, which deletes the links and the chats kept
          with it.
        </p>
      </Section>
      <Section title="The networks you link">
        <p>
          Each network has its own terms. Some of them — Instagram in particular — do not allow apps to sign in to a personal account the
          way Sytext does, and using it that way can get an account limited or locked. You choose whether that trade is worth it; Sytext
          says so plainly before you link.
        </p>
      </Section>
      <Section title="No warranty">
        <p>
          Sytext is provided as it is, without a guarantee that messages arrive, that a link keeps working, or that a network will keep
          allowing it. Do not rely on it alone for anything that matters.
        </p>
      </Section>
      <Section title="Changes">
        <p>These terms can change as the app does. The date of the last change is shown with each release.</p>
      </Section>
    </PublicPage>
  )
}

export function PrivacyPage() {
  return (
    <PublicPage title="Privacy policy" lead="What Sytext keeps, where it keeps it, and what it never sees.">
      <Section title="What the server keeps">
        <p>
          Your email address and name; the links to your accounts, encrypted; and the latest messages of each chat, encrypted, so a new
          device can catch up. Older messages are trimmed away. Profile pictures are kept only as small images for the chat list.
        </p>
      </Section>
      <Section title="What your devices keep">
        <p>
          Each browser keeps its own copy of the chats it has seen, so the app opens instantly and works offline. Signing out deletes
          that copy from the device.
        </p>
      </Section>
      <Section title="What the AI sees">
        <p>
          Only the chats you choose, and only while AI assist is on. With your own key, requests go straight from your browser to the
          provider you picked. With the shared AI, they go through this server to the provider it is set up with.
        </p>
      </Section>
      <Section title="What is never kept">
        <p>Your network passwords (apart from the one case where a site has no other way in, and then only encrypted), and your AI key.</p>
      </Section>
      <Section title="Deleting everything">
        <p>
          Deleting your account removes your profile, the account links, the chats kept on the server, and the tasks and state kept with
          them. Messages already delivered on WhatsApp, Telegram or Instagram stay where they are: those are their networks, not this one.
        </p>
      </Section>
    </PublicPage>
  )
}
