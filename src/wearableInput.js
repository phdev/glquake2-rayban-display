const ACTION_IDS = {
  forward: 0,
  attack: 1,
  jump: 2,
  crouch: 3,
  use: 4
};

const actionState = {
  forward: false,
  attack: false,
  jump: false,
  crouch: false,
  use: false
};

export function createWearableInput({
  getEngine,
  onForwardChange,
  onActionChange,
  onRecenter,
  onTurnBurst
}) {
  let lastUpGesture = 0;

  function install() {
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("q2gesture", onGestureEvent, true);
  }

  function dispose() {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("q2gesture", onGestureEvent, true);
  }

  function onKeyDown(event) {
    const gesture = platformKeyToGesture(event);
    if (!gesture || event.repeat) {
      return;
    }

    capture(event);
    handleGesture(gesture, true);
  }

  function onKeyUp(event) {
    const gesture = platformKeyToGesture(event);
    if (!gesture) {
      return;
    }

    capture(event);
    handleGesture(gesture, false);
  }

  function onGestureEvent(event) {
    const gesture = event.detail?.gesture;
    if (gesture) {
      handleGesture(gesture, event.detail?.active !== false);
    }
  }

  function handleGesture(gesture, active) {
    if (!active) {
      return;
    }

    if (gesture === "pinchTap") {
      setAction("forward", !actionState.forward);
      onForwardChange?.(actionState.forward);
      return;
    }

    if (gesture === "swipeUp") {
      const now = performance.now();
      if (now - lastUpGesture < 360) {
        pulseAction("jump", 240);
        pulseAction("attack", 260);
      } else {
        pulseAction("attack", 180);
      }
      lastUpGesture = now;
      return;
    }

    if (gesture === "swipeDown") {
      onRecenter?.();
      return;
    }

    if (gesture === "swipeLeft") {
      onTurnBurst?.(-1);
      return;
    }

    if (gesture === "swipeRight") {
      onTurnBurst?.(1);
    }
  }

  function setAction(action, down) {
    if (actionState[action] === down) {
      return;
    }

    actionState[action] = down;
    onActionChange?.(action, down);

    const engine = getEngine();
    if (engine) {
      engine.setWearableAction(ACTION_IDS[action], down);
    }
  }

  function pulseAction(action, durationMs) {
    setAction(action, true);
    window.setTimeout(() => setAction(action, false), durationMs);
  }

  function toggleForward() {
    handleGesture("pinchTap", true);
  }

  function fire() {
    handleGesture("swipeUp", true);
  }

  function jumpFire() {
    pulseAction("jump", 240);
    pulseAction("attack", 260);
  }

  function recenter() {
    handleGesture("swipeDown", true);
  }

  function turn(direction) {
    onTurnBurst?.(direction);
  }

  return {
    install,
    dispose,
    toggleForward,
    fire,
    jumpFire,
    recenter,
    turn,
    getState: () => ({ ...actionState })
  };
}

function platformKeyToGesture(event) {
  const key = String(event.key || "");

  if (key.startsWith("Arrow")) {
    const direction = key.slice("Arrow".length).toLowerCase();
    if (direction === "up") return "swipeUp";
    if (direction === "down") return "swipeDown";
    if (direction === "left") return "swipeLeft";
    if (direction === "right") return "swipeRight";
  }

  if (key === "Enter" || key === " ") {
    return "pinchTap";
  }

  return null;
}

function capture(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}
