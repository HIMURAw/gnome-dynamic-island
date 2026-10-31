// Smoke motion: in the fume theme things arrive out of a blur and leave into one, one after
// another, top to bottom, the way the glassy dashboard Umut liked (2026-11-01) swaps its pages.
// Other themes keep their own motion: callers ask smokeOn() first.
// Same file in Dynamic Island, Glass Dock and Glass Widgets; keep them identical.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {currentPalette} from './theme.js';

const EFFECT = 'smoke-blur';
// How soft a thing is when it starts to arrive or has finished leaving (px).
const SOFT = 14;

export function smokeOn() {
    return Boolean(currentPalette().smoke) && St.Settings.get().enable_animations;
}

// Blurs the actor's own pixels (its content, not what is behind it) by radius px, 0 removes it.
function setBlur(actor, radius) {
    let effect = actor.get_effect(EFFECT);
    if (radius <= 0) {
        if (effect)
            actor.remove_effect(effect);
        return;
    }
    if (!effect) {
        effect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: 1, radius: 0});
        actor.add_effect_with_name(EFFECT, effect);
    }
    effect.radius = Math.round(radius);
}

function blurNow(actor) {
    return actor.get_effect(EFFECT)?.radius ?? 0;
}

export function stopSmoke(actor) {
    const timeline = actor._smokeTimeline;
    if (!timeline)
        return;
    delete actor._smokeTimeline;
    timeline.stop();
}

// The blur radius has no transition of its own, so a timeline runs it alongside the ease.
// Only one may drive an actor's blur (see mistakes/Çakışan Animasyonlar): a new one stops the old.
function animateBlur(actor, to, {delay = 0, duration, mode}) {
    const from = blurNow(actor);
    stopSmoke(actor);
    if (from === to) {
        setBlur(actor, to);
        return;
    }
    // In step with ease(), which stretches by the shell's slow-down factor (and so must this).
    const slow = St.Settings.get().slow_down_factor;
    const timeline = new Clutter.Timeline({
        actor,
        duration: Math.max(1, Math.round(duration * slow)),
        delay: Math.round(delay * slow),
        progress_mode: mode,
    });
    // Destroyed mid-way (a widget removed, the dock rebuilt): stop without touching it again.
    let destroyId = actor.connect('destroy', () => {
        destroyId = 0;
        stopSmoke(actor);
    });
    timeline.connect('new-frame', () => setBlur(actor, from + (to - from) * timeline.get_progress()));
    timeline.connect('stopped', (_timeline, finished) => {
        if (actor._smokeTimeline === timeline)
            delete actor._smokeTimeline;
        if (!destroyId)
            return;
        actor.disconnect(destroyId);
        destroyId = 0;
        // Run to the end, nothing stays blurred: an arriving actor is sharp, a leaving one is
        // transparent by now. Interrupted, the blur stays for the next animation to start from.
        if (finished)
            setBlur(actor, 0);
    });
    actor._smokeTimeline = timeline;
    timeline.start();
}

// Arrives: from transparent, a little low and soft (and, with grow < 1, a little small), to in
// place and sharp.
export function reveal(actor, {delay = 0, duration = 420, rise = 10, soft = SOFT, grow = 1} = {}) {
    for (const p of ['opacity', 'translation-y', 'scale-x', 'scale-y'])
        actor.remove_transition(p);
    actor.set_pivot_point(0.5, 0.5);
    actor.set({opacity: 0, translation_y: rise, scale_x: grow, scale_y: grow});
    setBlur(actor, soft);
    const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;
    // The size settles with a touch of overshoot, the rest glides in.
    if (grow !== 1)
        actor.ease({scale_x: 1, scale_y: 1, delay, duration: duration + 80, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    actor.ease({opacity: 255, translation_y: 0, delay, duration, mode});
    animateBlur(actor, 0, {delay, duration: Math.round(duration * 0.85), mode});
}

// Leaves: softens and fades where it is. onStopped runs however it ends.
export function conceal(actor, {delay = 0, duration = 200, soft = SOFT, onStopped} = {}) {
    actor.remove_transition('opacity');
    const mode = Clutter.AnimationMode.EASE_IN_QUAD;
    actor.ease({opacity: 0, delay, duration, mode, onStopped});
    animateBlur(actor, soft, {delay, duration, mode});
}

// Children one after another, in the order given (callers pass them top to bottom).
// Stagger is capped so a long list does not keep the last rows waiting.
export function revealAll(actors, {delay = 0, step = 50, maxSteps = 8, ...rest} = {}) {
    actors.forEach((actor, i) => reveal(actor, {delay: delay + Math.min(i, maxSteps) * step, ...rest}));
}

export function concealAll(actors, {delay = 0, step = 25, maxSteps = 6, ...rest} = {}) {
    actors.forEach((actor, i) => conceal(actor, {delay: delay + Math.min(i, maxSteps) * step, ...rest}));
}

// Clears what smoke motion left on an actor (on destroy, or when the theme changes mid-way).
export function clearSmoke(actor) {
    stopSmoke(actor);
    setBlur(actor, 0);
}
