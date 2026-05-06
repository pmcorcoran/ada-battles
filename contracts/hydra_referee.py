from opshin.prelude import *

# 
# data structures
# 

@dataclass
class BulletState(PlutusData):
    is_active: bool  # True if flying, False if ready to fire
    x: int
    y: int
    dir_x: int       # Trajectory X
    dir_y: int       # Trajectory Y

@dataclass
class PlayerState(PlutusData):
    x_coord: int
    y_coord: int
    health: int
    last_shot_frame: int       
    bullets: List[BulletState]   

@dataclass
class PlayerInput(PlutusData):
    new_x: int
    new_y: int
    is_shooting: bool            
    aim_dir_x: int
    aim_dir_y: int
    current_frame: int           # The current game tic

# constants
MAX_SPEED = 100    #can be changed
COOLDOWN_FRAMES = 52  # 1.5 seconds at 35 FPS
BULLET_SPEED = 200  # Fixed speed for bullets
MAX_HEALTH = 2
# 
#  validator
# 

def validator(datum: PlayerState, redeemer: PlayerInput, context: ScriptContext) -> None:
    tx_info = context.transaction
    redeemer: PlayerInput = context.redeemer
    datum: PlayerState = own_datum_unsafe(context)

    # calculate how far the player is trying to move
    # using Manhattan distance here for lightweight  computation
    delta_x = abs(redeemer.new_x - datum.x_coord)
    delta_y = abs(redeemer.new_y - datum.y_coord)

    # enforce the speed limit. 
    # if the player tries to move 500 units, the contract crashes and rejects the transaction.
    assert delta_x <= MAX_SPEED, "Cheat Detected: Player moved too fast on the X axis"
    assert delta_y <= MAX_SPEED, "Cheat Detected: Player moved too fast on the Y axis"

    # ensure the state is actually updated securely.
    # must check that the transaction creates a new UTxO at this exact same 
    # contract address, and that the new UTxO contains the updated coordinates.
    
    # extract the single output going back to this contract
    own_outputs = [
        tx_out for tx_out in context.transaction.outputs 
        if tx_out.address == context.transaction.outputs[0].address # Simplified address check
    ]
    assert len(own_outputs) == 1, "Must create exactly one new state output"
    
    # Read the new Datum from the output
    new_datum: PlayerState = own_outputs[0].datum.value
    
    # RULE 3: Verify the output matches the requested, legal movement
    assert new_datum.x_coord == redeemer.new_x, "State X does not match requested X"
    assert new_datum.y_coord == redeemer.new_y, "State Y does not match requested Y"
    
    # If the code reaches this line without hitting an 'assert' failure, 
    # the math checks out, and the transaction is successfully written to the ledger!
    
    # 
    # the 1.5 second cooldown
    # 
    if redeemer.is_shooting:
        frames_since_last_shot = redeemer.current_frame - datum.last_shot_frame
        assert frames_since_last_shot >= COOLDOWN_FRAMES, "Cheat Detected: Firing too fast!"

    # 
    #  Managing the 4 Bullets and Fixed Speed
    # 
    
    # Extract the new state from the transaction output to verify it
    own_outputs = [tx_out for tx_out in context.transaction.outputs if tx_out.address == context.tx_info.outputs[0].address]
    new_datum: PlayerState = own_outputs[0].datum.value
    
    # Ensure the player still only has exactly 4 bullets (hidden constraint)
    assert len(new_datum.bullets) == 4, "System Error: Player must have exactly 4 bullets"

    # Verify the physics of every bullet in the array
    for i in range(4):
        old_bullet = datum.bullets[i]
        new_bullet = new_datum.bullets[i]

        if old_bullet.is_active:
            # RULE: Bullets move at a fixed speed. 
            # The contract forces the bullet to move exactly BULLET_SPEED units along its trajectory.
            expected_x = old_bullet.x + (old_bullet.dir_x * BULLET_SPEED)
            expected_y = old_bullet.y + (old_bullet.dir_y * BULLET_SPEED)
            
            assert new_bullet.x == expected_x, "Cheat Detected: Bullet X speed altered!"
            assert new_bullet.y == expected_y, "Cheat Detected: Bullet Y speed altered!"
            
        elif redeemer.is_shooting and new_bullet.is_active:
            # This is the bullet that was just fired this exact frame
            assert new_bullet.x == datum.x_coord, "Cheat Detected: Bullet must spawn at player location"
            assert new_bullet.dir_x == redeemer.aim_dir_x, "Cheat Detected: Bullet trajectory mismatch"

    

    if datum.health <= 0:
        assert redeemer.new_x == datum.x_coord, "Cheat Detected: Dead players cannot move!"
        assert redeemer.new_y == datum.y_coord, "Cheat Detected: Dead players cannot move!"
        assert not redeemer.is_shooting, "Cheat Detected: Dead players cannot shoot!"
        # We skip the rest of the checks because a dead player can only wait to respawn
        
    else:
        assert delta_x <= MAX_SPEED, "Cheat Detected: Player moved too fast on the X axis"
        assert delta_y <= MAX_SPEED, "Cheat Detected: Player moved too fast on the Y axis"
        
            
        frames_since_last_shot = redeemer.current_frame - datum.last_shot_frame
        assert frames_since_last_shot >= COOLDOWN_FRAMES, "Cheat Detected: Firing too fast!"
        
        pass

    # Extract the new state from the transaction output to verify it
    own_outputs = [tx_out for tx_out in context.transaction.outputs if tx_out.address == context.tx_info.outputs[0].address]
    new_datum: PlayerState = own_outputs[0].datum.value
    
    # 
    #  Health Bounds
    # 
    assert new_datum.health >= 0, "System Error: Health cannot be negative"
    assert new_datum.health <= MAX_HEALTH, "Cheat Detected: Health exceeds maximum Doom limits"

    
    # A player cannot arbitrarily increase their own health. If their new health is 
    # higher than their old health, they must prove their killer died.
    
    #if new_datum.health > datum.health:
 
        #assert players killer is dead.