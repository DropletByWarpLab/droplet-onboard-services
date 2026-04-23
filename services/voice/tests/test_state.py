"""State machine — transition graph + listener fan-out."""

import pytest

from state import State, StateMachine


def test_initial_state_is_idle():
    sm = StateMachine()
    assert sm.current == State.IDLE


def test_legal_transitions():
    sm = StateMachine()
    sm.set(State.LISTENING)
    assert sm.current == State.LISTENING
    sm.set(State.PROCESSING)
    sm.set(State.SPEAKING)
    sm.set(State.IDLE)


@pytest.mark.parametrize(
    "from_state,to_state",
    [
        (State.IDLE, State.PROCESSING),       # can't process without capture
        (State.LISTENING, State.SPEAKING),    # must process first
        (State.SPEAKING, State.LISTENING),    # speaker bleed risk
        (State.SPEAKING, State.PROCESSING),
        (State.MUTED, State.LISTENING),       # only IDLE is reachable from MUTED
        (State.MUTED, State.SPEAKING),
    ],
)
def test_illegal_transitions(from_state, to_state):
    sm = StateMachine(initial=from_state)
    with pytest.raises(ValueError, match="invalid transition"):
        sm.set(to_state)


def test_force_bypasses_validation():
    """Mute must always be reachable, even from mid-speak / mid-listen.
    `force()` is the path used by the /mute endpoint."""
    sm = StateMachine(initial=State.SPEAKING)
    sm.force(State.MUTED)
    assert sm.current == State.MUTED


def test_listener_fires_on_change():
    sm = StateMachine()
    seen: list[tuple[State, State]] = []
    sm.on_change(lambda old, new: seen.append((old, new)))
    sm.set(State.LISTENING)
    sm.set(State.PROCESSING)
    sm.set(State.IDLE)
    assert seen == [
        (State.IDLE, State.LISTENING),
        (State.LISTENING, State.PROCESSING),
        (State.PROCESSING, State.IDLE),
    ]


def test_listener_doesnt_fire_on_no_op_set():
    sm = StateMachine(initial=State.IDLE)
    seen: list[tuple[State, State]] = []
    sm.on_change(lambda old, new: seen.append((old, new)))
    sm.set(State.IDLE)
    assert seen == []


def test_listener_exception_doesnt_block_subsequent_listeners():
    sm = StateMachine()
    fired: list[str] = []
    def bad(_o, _n): raise RuntimeError("boom")
    def good(_o, _n): fired.append("ok")
    sm.on_change(bad)
    sm.on_change(good)
    sm.set(State.LISTENING)
    assert fired == ["ok"]
