import React from "react";

export default function Mission() {
  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-10 py-24">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Manifesto · 01</div>
      <h1 className="font-display text-5xl md:text-8xl uppercase font-black tracking-tighter mt-3 leading-[0.85]">
        We build the room, the sound, and the door.
      </h1>
      <div className="mt-12 space-y-8 text-zinc-300 text-lg leading-relaxed max-w-2xl">
        <p>Umbra is a music and performance collective in Bucharest. We programme our own nights, work with our own artists, and run our own box office. No promoter. No middleman.</p>
        <p>The site you're on is the storefront. The ticketing engine behind it is ours. Every ticket sold, every scan at the door, every invoice — it all lands with us.</p>
        <p>We keep the money inside the work. What comes in from the door pays the artists, the crew, the room, the light, the sound. What's left builds the next project.</p>
        <p className="font-display text-2xl uppercase tracking-tight text-white">
          After midnight, the collective owns its whole funnel.
        </p>
      </div>
    </div>
  );
}
