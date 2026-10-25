import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatSocket, CLOSE_EXPIRED } from "../src/chat-socket.ts";

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  say(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const frames: unknown[] = [];
  const states: boolean[] = [];
  const waits: number[] = [];
  let token = "t1";
  let refreshed = 0;
  const chat = new ChatSocket(
    {
      url: () => "wss://chat.test/w/w1/v1/ws",
      token: () => token,
      refresh: async () => {
        refreshed++;
      },
    },
    (frame) => frames.push(frame),
    (connected) => states.push(connected),
    (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    (work, ms) => {
      waits.push(ms);
      return setTimeout(work, 0);
    },
  );
  return {
    chat,
    sockets,
    frames,
    states,
    waits,
    setToken: (t: string) => (token = t),
    refreshed: () => refreshed,
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("it connects with the token in the protocols, and says hello with where it has got to", async () => {
  const { chat, sockets } = setup();
  chat.start();
  await tick();
  assert.deepEqual(sockets[0]?.protocols, ["hive.v1", "t1"]);
  sockets[0]?.onopen?.();
  assert.equal(sockets[0]?.sent[0], JSON.stringify({ t: "hello", cursor: 0 }));
  chat.stop();
});

test("it is connected once the service says it is ready, and passes the events on, keeping the last number", async () => {
  const { chat, sockets, frames, states } = setup();
  chat.start();
  await tick();
  const socket = sockets[0] as FakeSocket;
  socket.onopen?.();
  socket.say({ t: "ready", cursor: 4 });
  socket.say({ t: "event", id: 7, type: "message.new", channelId: "c", data: {} });
  socket.say("pong");
  socket.say("not json");
  assert.deepEqual(states, [true]);
  assert.equal(frames.length, 2);
  // Connecting again, it asks for what came after.
  socket.onclose?.({ code: 1006 });
  assert.deepEqual(states, [true, false]);
  await tick();
  await tick();
  sockets[1]?.onopen?.();
  assert.equal(sockets[1]?.sent[0], JSON.stringify({ t: "hello", cursor: 7 }));
  chat.stop();
});

test("it connects again after a break, waiting longer each time and starting over once it is back", async () => {
  const { chat, sockets, waits } = setup();
  chat.start();
  await tick();
  for (let i = 0; i < 3; i++) {
    sockets.at(-1)?.onclose?.({ code: 1006 });
    await tick();
    await tick();
  }
  assert.deepEqual(waits.slice(0, 3), [500, 1000, 2000]);
  const last = sockets.at(-1) as FakeSocket;
  last.onopen?.();
  last.say({ t: "ready", cursor: 1 });
  last.onclose?.({ code: 1006 });
  await tick();
  assert.equal(waits.at(-1), 500, "after being connected it starts again at the short wait");
  chat.stop();
});

test("a token that ran out is replaced at once, with a fresh one", async () => {
  const { chat, sockets, waits, setToken, refreshed } = setup();
  chat.start();
  await tick();
  const first = refreshed();
  setToken("t2");
  sockets[0]?.onclose?.({ code: CLOSE_EXPIRED });
  await tick();
  assert.equal(sockets[1]?.protocols[1], "t2");
  assert.equal(refreshed(), first + 1, "asked for a fresh token before connecting");
  assert.deepEqual(waits, [], "without waiting");
  chat.stop();
});

test("a service that says what was missed is too much to send is passed on", async () => {
  const { chat, sockets, frames } = setup();
  chat.start();
  await tick();
  sockets[0]?.onopen?.();
  sockets[0]?.say({ t: "resync", cursor: 90 });
  assert.deepEqual(frames, [{ t: "resync", cursor: 90 }]);
  chat.stop();
});

test("stopping ends it and it does not come back; typing is only sent while connected", async () => {
  const { chat, sockets } = setup();
  chat.start();
  await tick();
  const socket = sockets[0] as FakeSocket;
  chat.send({ t: "typing", channelId: "c" });
  assert.equal(socket.sent.length, 0, "nothing while there is no connection");
  socket.onopen?.();
  socket.say({ t: "ready", cursor: 0 });
  chat.send({ t: "typing", channelId: "c" });
  assert.equal(socket.sent.at(-1), JSON.stringify({ t: "typing", channelId: "c" }));
  chat.stop();
  assert.equal(socket.closed, true);
  await tick();
  assert.equal(sockets.length, 1);
});

test("nudging connects now if it is waiting", async () => {
  const { chat, sockets } = setup();
  chat.start();
  await tick();
  sockets[0]?.onclose?.({ code: 1006 });
  chat.nudge();
  await tick();
  assert.equal(sockets.length, 2);
  chat.stop();
});
