"""
Ada Battles — HEALTH validator.

Spends a player's Health UTxO. This is the only cross-player write and the
terminal state fanned out at Head close (keep it L1-affordable). Two transitions
share this UTxO, dispatched on the redeemer union:

  HitInput   — shooter-asserted damage. The SHOOTER (not the victim) authors and
               signs. The shooter ALSO spends their own Bullets UTxO in the same
               transaction to consume the landing bullet (active->inactive); the
               bullets validator there checks that bullet's flight was valid up
               to this checkpoint, so the position we test against here is
               contract-verified, not peer-trusted. We require the consumed
               bullet to have intersected the victim's referenced position.

  ReviveInput — self-revive. The owner authors and signs. Legitimate only if the
               player named in eliminated_by is CURRENTLY dead (missing the
               window because the killer already revived is just tough luck),
               within REVIVE_WINDOW_CHECKPOINTS, and the respawn point clears
               every other live player by SPAWN_MIN_DISTANCE.

Entry point is `validator`.
"""

from opshin.prelude import *
from .shared import *


def spent_bullet(inputs: List[TxInInfo], shooter: PubKeyHash, index: int) -> Bullet:
    """Read bullets[index] from the shooter's Bullets UTxO that is being SPENT
    in this same transaction (not a reference input — the bullet is consumed).
    """
    found: int = 0
    result: Bullet = Bullet(shooter, False, 0, 0, 0, 0)
    for ti in inputs:
        od: OutputDatum = ti.resolved.datum
        if isinstance(od, SomeOutputDatum):
            bs: BulletsState = od.datum
            if bs.owner == shooter:
                assert len(bs.bullets) == BULLET_COUNT, "spent bullets malformed"
                result = bs.bullets[index]
                found += 1
    assert found == 1, "shooter must spend exactly their own bullets utxo"
    return result


def check_spawn_clearance(reference_inputs: List[TxInInfo], me: PubKeyHash, rx: int, ry: int) -> None:
    """Respawn must clear every other LIVE referenced player by SPAWN_MIN_DISTANCE.

    The off-chain builder references exactly the N-1 other players. Dead players
    are parked off-canvas and excluded by their alive flag.
    """
    for ti in reference_inputs:
        od: OutputDatum = ti.resolved.datum
        if isinstance(od, SomeOutputDatum):
            ps: PositionState = od.datum
            if ps.owner != me and ps.alive:
                d2: int = dist_sq(rx, ry, ps.x, ps.y)
                assert d2 >= SPAWN_MIN_DISTANCE_SQ, "respawn too close to a live player"


def validator(context: ScriptContext) -> None:
    purpose: ScriptPurpose = context.purpose
    assert isinstance(purpose, Spending), "health is a spending validator"
    spending: Spending = purpose

    datum: HealthState = own_datum_unsafe(context)
    redeemer: Union[HitInput, ReviveInput] = context.redeemer
    tx_info: TxInfo = context.transaction

    own_in: TxOut = own_spent_utxo(tx_info.inputs, spending)
    own_addr: Address = own_in.address
    new_out: TxOut = continuing_output(tx_info.outputs, own_addr)
    new_state: HealthState = out_health(new_out)

    assert new_state.owner == datum.owner, "health owner must not change"
    assert new_state.health >= MIN_HEALTH, "health below minimum"
    assert new_state.health <= MAX_HEALTH, "health above maximum"

    if isinstance(redeemer, HitInput):
        hit: HitInput = redeemer
        shooter: PubKeyHash = hit.shooter

        # Shooter authors the hit; victim does NOT sign (that is the whole point
        # of shooter-assertion — the victim cannot withhold their own damage).
        assert shooter != datum.owner, "a player cannot hit themselves"
        assert shooter in tx_info.signatories, "shooter must sign the hit they assert"

        # Victim must currently be alive to take a hit.
        assert datum.health > MIN_HEALTH, "cannot hit an already-dead player"

        # The landing bullet is consumed: it is in the shooter's Bullets UTxO,
        # which the shooter SPENDS in this tx. Read it from the inputs.
        bullet: Bullet = spent_bullet(tx_info.inputs, shooter, hit.bullet_index)
        assert bullet.owner == shooter, "landing bullet must belong to the shooter"
        assert bullet.is_active, "landing bullet must be active in the spent state"

        # Geometry: the bullet's position must intersect the victim's referenced
        # position within HIT_RADIUS (squared compare, no sqrt).
        victim_pos: PositionState = ref_position(tx_info.reference_inputs, datum.owner)
        d2: int = dist_sq(bullet.x, bullet.y, victim_pos.x, victim_pos.y)
        assert d2 <= HIT_RADIUS_SQ, "asserted hit does not intersect victim"

        # Exactly one point of damage.
        assert new_state.health == datum.health - HIT_DAMAGE, "hit must decrement health by exactly one"

        if new_state.health <= MIN_HEALTH:
            assert new_state.eliminated_by == shooter, "eliminated_by must record the shooter"
            assert new_state.died_at_checkpoint == hit.checkpoint, "died_at must record this checkpoint"
        else:
            assert new_state.eliminated_by == datum.eliminated_by, "eliminated_by changed on non-kill"
            assert new_state.died_at_checkpoint == datum.died_at_checkpoint, "died_at changed on non-kill"

    else:
        revive: ReviveInput = redeemer

        # Owner authors and signs their own revival.
        assert datum.owner in tx_info.signatories, "only the owner may revive themselves"
        assert datum.health <= MIN_HEALTH, "cannot revive a living player"

        # Killer must be CURRENTLY dead, and have died within the window. If the
        # killer already revived, the window was missed — tough luck.
        killer: PubKeyHash = datum.eliminated_by
        assert killer != ALIVE_SENTINEL, "no recorded killer to gate revive"
        killer_health: HealthState = ref_health(tx_info.reference_inputs, killer)
        assert killer_health.health <= MIN_HEALTH, "killer is not dead — revive not permitted"
        killer_died: int = killer_health.died_at_checkpoint
        assert killer_died > 0, "killer has no recorded death"
        elapsed: int = revive.checkpoint - killer_died
        assert elapsed >= 0, "revive checkpoint precedes killer death"
        assert elapsed <= REVIVE_WINDOW_CHECKPOINTS, "revive window elapsed"

        # Respawn clearance against the N-1 referenced live players.
        check_spawn_clearance(tx_info.reference_inputs, datum.owner, revive.respawn_x, revive.respawn_y)

        # Restore to full health, clear elimination bookkeeping.
        assert new_state.health == MAX_HEALTH, "revive must restore full health"
        assert new_state.eliminated_by == ALIVE_SENTINEL, "revive must clear eliminated_by to ALIVE_SENTINEL"
        assert new_state.died_at_checkpoint == 0, "revive must clear died_at"