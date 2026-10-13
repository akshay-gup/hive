# Hive mobile

A shared React Native workspace for iOS, Android, and the web preview. The client uses native primitives and the CopilotKit headless hooks; the web preview renders those same screens through React Native Web.

## Demos

[![Hive on iPhone — watch the 38-second demo](../../assets/demos/2026-09-16/mobile.png)](../../assets/demos/2026-09-16/mobile.mp4)

[iPhone · 38 seconds](../../assets/demos/2026-09-16/mobile.mp4) · [Desktop web · 42 seconds](../../assets/demos/2026-09-16/web.mp4) · [Recording setup](../../docs/DEMO.md)

Meet Hive's capybara in two different journeys: Hacker News and CopilotKit on iPhone; reading a school-trip email and researching aquarium exhibits on desktop. Results appear inline in chat, with **Take control** opening the same browser session. Send and Stop share the input pill's primary control.

## Run

Start the API from the repository root, then:

```sh
pnpm --dir apps/mobile web
pnpm --dir apps/mobile ios
pnpm --dir apps/mobile android
```

**Which workspace** (a build without `EXPO_PUBLIC_CONTROL_URL`). The app opens the workspace it was last pointed at. Failing that, a web page served by a workspace uses that workspace, a build with `EXPO_PUBLIC_API_URL` set uses that address, and a development build on a phone or emulator uses `http://localhost:8787` (`http://10.0.2.2:8787` on the Android emulator). Otherwise it asks for the workspace address on first launch, checks that a Hive workspace answers there (`/api/health`), and remembers it; **Use a different workspace** on the sign-in card asks again. Plain `http://` is accepted only for addresses on the device's own network. A workspace that a website or app reaches from elsewhere must list that website in its `ALLOWED_ORIGINS`.

**Signing in.** Live mode signs in with Google; local mode opens the fictional workspace automatically. The session is kept per workspace, in `localStorage` on the web and in the keychain (`expo-secure-store`) on iOS and Android. A sign-in is tied to the app that started it: the app keeps a random proof, sends the server only its SHA-256 when it starts, and has to show the proof to turn the one-time code that comes back into a session, so another app that receives the `hive://auth` link cannot use it. A code that arrives without a sign-in started in the app is ignored.

A build made with `EXPO_PUBLIC_CONTROL_URL` set to a control plane's address is the hosted app: people sign in there, see their workspaces, make or join one, and are taken into it, and `EXPO_PUBLIC_API_URL` is not used. See [Hosted workspaces](../../docs/hosted.md). An invitation link (`/join/<token>` on the web, `hive://join/<token>` on a phone) opens the join screen.

PDFs use `react-native-pdf` and `react-native-blob-util` in an Expo **development build**. Expo Go does not include these native modules. The config plugins in `app.json` configure the native projects. Web uses the browser’s real PDF reader, with page/zoom controls and download/print access. PDF form fields save a new server artifact.

## Checks

```sh
pnpm --dir apps/mobile typecheck
node --experimental-strip-types --test apps/mobile/test/date-time.test.ts
pnpm --dir apps/mobile build:web
pnpm --dir apps/mobile build:ios
pnpm --dir apps/mobile build:android
```

The `build:ios` and `build:android` commands validate and export platform JavaScript/Hermes bundles. They do not create signed installable apps. `ios` and `android` run Expo’s native development-build workflows and need the platform toolchains.

## Design tokens

Every colour, text size, corner radius and shadow lives in `src/theme.ts`. Components ask for a role (`colors.primary`, `fontSize.ui`, `radius.lg`, `shadow.card`), never a value, so applying a style guide means editing that one file. `test/theme.test.ts` fails if a raw colour appears anywhere else, or if a text and background pair in the theme drops below WCAG AA contrast (4.5:1). The app is dark only; a light theme would be a second object with the same keys as `colors`, chosen from a context.

The values follow the web app's stylesheet:

- **Colour.** `palette` holds the brand swatches (navy, blue, teal, amber) for art, and `colors` gives the app its roles in Graphite: a charcoal `canvas`, faint white surfaces and hairlines, light ink, and the brand teal as `primary` with white text on it (`onPrimary`). Links and other teal text use `primaryText`, a lighter teal. A web page or document shown in a frame sits on `paper`, since those assume white. Amber marks creation: `CreateTile` is the dashed "create something new" outline. A selected card or pill has a plain teal border (`selectedCard`).
- **Shape.** Cards use 12px corners and hairline borders; task cards and file cards also lift on hover. Larger cards (files, the finance summary, the Today banner) use `radius.xxl`, 25px.
- **Glass.** Panels are faint white (`glass`) over a neutral charcoal backdrop (`haze`) that is a shade lighter at the top left, with a hairline, a rim that catches more light along the top and left edges, and a soft shadow, and no glow. On a wide window the sidebar, the main area and a channel's thread are separate panels with `layout.gap` between them (`panelStyle`); on a phone the header and tab bar float. The haze rises only about 24 levels over some 700 pixels, and in the dark one level is a large step in brightness, so a browser's own gradient shows each level as a flat band. The web makes the haze as a picture instead (`HazeImage`): `hazePixels` works each pixel out exactly and adds up to half a level of noise before rounding it, so the average follows the true gradient, and a test checks that against an exact one. The picture is made once at the window's size, one pixel for each CSS pixel, as a BMP (`hazeBmp`) and shown as a background image, so it costs the page no more per frame than a CSS gradient. A panel is a translucent fill over it with no blur, because a blur would average the dither back into steps; a sheet blurs the page behind it with `backdropFilter`, which react-native-web passes through. Native takes the slightly more opaque `*Solid` fills. A build made with `EXPO_PUBLIC_LIQUID_GLASS=1` also draws, on iOS, the haze through React Native's `experimental_backgroundImage` and, on iOS 26 or later, the phone's header and tab bar and the composer as Apple's Liquid Glass (`GlassBar`, through `expo-glass-effect`); Android is unchanged. Expo inlines the variable, so clear Metro's cache (`expo export --clear`) when it changes, and the module has to be in the build, which means a new development build. Hairlines and quiet fills (`line`, `surfaceMuted`) are tints of white, so they suit the backdrop, a panel and a card alike. The theme test checks text on every glass fill over the lightest part of the backdrop.
- **Poppins.** The web build uses Poppins, self-hosted in `public/fonts` with its SIL Open Font License (four weights, Latin and Latin-extended). `src/fonts.ts` registers it and makes it the font of every `Text`. react-native-web does not inherit fonts, so the rule matches the `dir="auto"` elements it renders; code opts out with `{...monoProps}`. iOS and Android keep the system font: Poppins there needs one font family per weight loaded with `expo-font`, which is not wired up yet.

## Behavior

- Chat, Activity, Ideas, Goals and Apps are the primary navigation. Tasks, timelines and notifications refresh from the durable server state. Apps contains Mail, Calendar, Browser, Files and Connections.
- Drafts are saved in Hive and can be reopened from Mail. Mail attachments import into Files before reading.
- Calendar edits preserve named time zones. Date entry rejects nonexistent times at daylight-saving transitions.
- Sending mail and creating, changing, or deleting events require a stored proposal and an explicit review decision. Editing a proposal declines the previous version, then opens a new draft.
- Chat restores/saves AG-UI conversation messages, renders frontend tool cards, and supports interruption, retry, and document references.
- While the agent replies, the send arrow becomes a stop square in the same input pill. Stop preserves the draft; the arrow returns when the run ends. A new message can continue immediately after stopping when no follow-ups are waiting. Held follow-ups resume through **Send queued messages**.
- Browser previews and consoles use only signed worker URLs returned by the API. PDF downloads import through the worker API.
- Google connects through the system browser. Refresh the workspace after completing OAuth.

Phone and wide layouts share Chat, Activity, Ideas, Goals and Apps. The task and notification sheets restore server state when reopened. Document and browser viewers have platform-specific files; presentation and state remain shared.
