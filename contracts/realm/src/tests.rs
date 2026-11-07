use super::*;
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

// Vectors produced by packages/rules (sealOrders / commit), so the contract and the
// TypeScript rules provably agree on what a seal is.
const ORDERS: &str = r#"{"orders":[{"from":3,"kind":"march","to":4},{"good":"iron","kind":"trade","qty":2,"side":"buy"}],"realm":1,"season":0}"#;
const ORDERS_SALT: &str = "salt-1";
const ORDERS_SEAL: &str = "133e5dbb694dc9e87f6f0c741b430ad0934e7f5b67d94a312fc79c101f58ca96";
const ROLL: &str = r#""roll-secret""#;
const ROLL_SALT: &str = "s2";
const ROLL_COMMIT: &str = "0cc2e375ff1c88701165d31bedeb61e2cb59d5cdbd089f4f7b985caa820ad169";

const SEASON_MS: u64 = 300_000;

fn owner() -> AccountId {
    accounts(0)
}
fn referee() -> AccountId {
    "referee.testnet".parse().unwrap()
}
fn ruler(i: usize) -> AccountId {
    accounts(1 + i) // bob, charlie, danny
}
fn chancellor() -> AccountId {
    "chancellor.testnet".parse().unwrap()
}
fn spy() -> AccountId {
    "spy.testnet".parse().unwrap()
}

fn as_(who: AccountId, at_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(who)
        .block_timestamp(at_ms * 1_000_000)
        .build());
}

fn agenda(i: usize) -> (String, String) {
    (format!(r#"{{"kind":"covet","text":"agenda {i}"}}"#), format!("agenda-salt-{i}"))
}

/// Three realms; realm 1 has a chancellor. Returns the contract and the campaign id.
fn setup() -> (RealmLedger, u64) {
    as_(owner(), 1_000);
    let mut c = RealmLedger::new(owner());
    c.add_referee(referee());
    as_(referee(), 1_000);
    let realms = (0..3)
        .map(|i| RealmInit {
            ruler: ruler(i),
            chancellor: if i == 1 { Some(chancellor()) } else { None },
            treasury: 500,
            season_cap: 200,
            campaign_cap: 1_000,
        })
        .collect();
    let commits = (0..3).map(|i| { let (a, s) = agenda(i); commitment(&a, &s) }).collect();
    let id = c.create_campaign(realms, "seed-1".into(), ROLL_COMMIT.into(), commits, 2, SEASON_MS);
    (c, id)
}

fn seal_hex(n: u8) -> String {
    format!("{:064x}", n)
}

#[test]
fn commitment_matches_the_typescript_rules() {
    as_(owner(), 0);
    assert_eq!(commitment(ORDERS, ORDERS_SALT), ORDERS_SEAL);
    assert_eq!(commitment(ROLL, ROLL_SALT), ROLL_COMMIT);
}

#[test]
fn seal_reveal_settle_finish() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    c.seal(id, 0, seal_hex(1));
    as_(ruler(1), 2_000);
    c.seal(id, 1, ORDERS_SEAL.into());
    assert_eq!(c.get_campaign(id).unwrap().phase, Phase::Sealing);
    as_(ruler(2), 2_000);
    c.seal(id, 2, seal_hex(3));
    assert_eq!(c.get_campaign(id).unwrap().phase, Phase::Revealing);

    // the referee may reveal on a ruler's behalf; the contract checks it against the seal
    as_(referee(), 3_000);
    c.reveal(id, 1, ORDERS.into(), ORDERS_SALT.into());
    assert!(c.get_seal(id, 0, 1).unwrap().revealed);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"revealed\"") && l.contains("march")));

    // realms 0 and 2 never reveal: after a further season the referee may settle them as forfeited
    as_(referee(), 2_000 + SEASON_MS * 2 + 1);
    c.settle_season(id, seal_hex(9), vec![10, -20, 0], vec![], vec![], Some(vec![0, 2]));
    let camp = c.get_campaign(id).unwrap();
    assert_eq!(camp.season, 1);
    assert_eq!(camp.phase, Phase::Sealing);
    assert_eq!(camp.realms[0].treasury, 510);
    assert_eq!(camp.realms[1].treasury, 480);
    assert_eq!(camp.state_hashes, vec![seal_hex(9)]);

    // season 1: nobody seals; the deadline passes; settle with realm 2 fallen
    let deadline = camp.seal_deadline_ms;
    as_(referee(), deadline + SEASON_MS);
    c.settle_season(id, seal_hex(10), vec![0, 0, 0], vec![2], vec![], None);
    assert_eq!(c.get_campaign(id).unwrap().phase, Phase::Ended);

    let agendas = (0..3).map(agenda).collect();
    c.finish_campaign(id, 0, ROLL.into(), ROLL_SALT.into(), agendas);
    let camp = c.get_campaign(id).unwrap();
    assert_eq!(camp.phase, Phase::Finished);
    assert_eq!(camp.winner, Some(0));
}

#[test]
#[should_panic(expected = "orders do not match the seal")]
fn altered_orders_are_rejected() {
    let (mut c, id) = setup();
    for i in 0..3 {
        as_(ruler(i), 2_000);
        c.seal(id, i as u8, ORDERS_SEAL.into());
    }
    as_(ruler(1), 3_000);
    c.reveal(id, 1, ORDERS.replace("\"to\":4", "\"to\":5"), ORDERS_SALT.into());
}

#[test]
#[should_panic(expected = "seals are not closed yet")]
fn no_reveal_while_others_are_still_sealing() {
    let (mut c, id) = setup();
    as_(ruler(1), 2_000);
    c.seal(id, 1, ORDERS_SEAL.into());
    c.reveal(id, 1, ORDERS.into(), ORDERS_SALT.into());
}

#[test]
#[should_panic(expected = "only the ruler seals its orders")]
fn only_the_ruler_seals() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    c.seal(id, 1, seal_hex(1));
}

#[test]
#[should_panic(expected = "already sealed this season")]
fn a_seal_cannot_be_replaced() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    c.seal(id, 0, seal_hex(1));
    c.seal(id, 0, seal_hex(2));
}

#[test]
#[should_panic(expected = "sealing is closed")]
fn no_seals_after_the_deadline() {
    let (mut c, id) = setup();
    as_(ruler(0), 1_000 + SEASON_MS);
    c.seal(id, 0, seal_hex(1));
}

#[test]
#[should_panic(expected = "waiting for reveals")]
fn settling_waits_for_reveals() {
    let (mut c, id) = setup();
    for i in 0..3 {
        as_(ruler(i), 2_000);
        c.seal(id, i as u8, seal_hex(1));
    }
    as_(referee(), 3_000);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], None);
}

#[test]
#[should_panic(expected = "an agenda does not match its commitment")]
fn finishing_checks_every_agenda() {
    let (mut c, id) = setup();
    as_(referee(), 2_000);
    let mut agendas: Vec<_> = (0..3).map(agenda).collect();
    agendas[2].0 = r#"{"kind":"hoard","text":"a lie"}"#.into();
    c.finish_campaign(id, 0, ROLL.into(), ROLL_SALT.into(), agendas);
}

#[test]
#[should_panic(expected = "roll secret does not match its commitment")]
fn finishing_checks_the_roll_secret() {
    let (mut c, id) = setup();
    as_(referee(), 2_000);
    c.finish_campaign(id, 0, r#""other""#.into(), ROLL_SALT.into(), (0..3).map(agenda).collect());
}

#[test]
fn treaties_are_signed_by_both_and_breaks_are_recorded() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    let t = c.propose_treaty(id, 0, 1, TreatyKind::Peace, 0);
    as_(ruler(1), 2_000);
    c.accept_treaty(id, t);
    assert_eq!(c.get_campaign(id).unwrap().treaties[0].signed_season, Some(0));

    as_(referee(), 1_000 + SEASON_MS * 2);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![(t, 0)], None);
    let tr = &c.get_campaign(id).unwrap().treaties[0];
    assert_eq!(tr.broken_season, Some(0));
    assert_eq!(tr.broken_by, Some(0));
}

#[test]
#[should_panic(expected = "only the other ruler accepts")]
fn a_proposer_cannot_accept_its_own_treaty() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    let t = c.propose_treaty(id, 0, 1, TreatyKind::Alliance, 0);
    c.accept_treaty(id, t);
}

#[test]
fn chancellor_hires_a_spy_and_pays_only_for_passed_work() {
    let (mut c, id) = setup();
    as_(ruler(1), 2_000);
    c.set_policy(id, 1, chancellor(), 100, 150);

    as_(chancellor(), 2_000);
    let job = c.hire(id, 1, spy(), JobKind::Spy, 60, "watch the Ember Pass".into());
    assert_eq!(c.get_campaign(id).unwrap().realms[1].treasury, 440);

    as_(spy(), 2_500);
    c.deliver(job, seal_hex(7));
    as_(chancellor(), 3_000);
    c.settle_job(job, true, "report matched the reveal".into());
    assert_eq!(c.get_earnings(id, spy()), 60);
    assert_eq!(c.get_job(job).unwrap().status, JobStatus::Paid);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"receipt\"") && l.contains("\"passed\":true")));

    // undelivered work is refunded and the budget returns
    let job2 = c.hire(id, 1, spy(), JobKind::Spy, 40, "count the iron hills".into());
    c.settle_job(job2, true, "never delivered".into());
    assert_eq!(c.get_job(job2).unwrap().status, JobStatus::Refunded);
    assert_eq!(c.get_campaign(id).unwrap().realms[1].treasury, 440);
    assert_eq!(c.get_policy(id, chancellor()).unwrap().spent_total, 60);
}

#[test]
#[should_panic(expected = "over this season's spending cap")]
fn policy_caps_spending_per_season() {
    let (mut c, id) = setup();
    as_(ruler(1), 2_000);
    c.set_policy(id, 1, chancellor(), 100, 1_000);
    as_(chancellor(), 2_000);
    c.hire(id, 1, spy(), JobKind::Spy, 60, "a".into());
    c.hire(id, 1, spy(), JobKind::Spy, 60, "b".into());
}

#[test]
#[should_panic(expected = "no spending policy for this agent")]
fn a_chancellor_without_a_policy_cannot_spend() {
    let (mut c, id) = setup();
    as_(chancellor(), 2_000);
    c.hire(id, 1, spy(), JobKind::Spy, 10, "a".into());
}

#[test]
#[should_panic(expected = "only the ruler or its chancellor spends")]
fn nobody_else_spends_a_treasury() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    c.hire(id, 1, spy(), JobKind::Spy, 10, "a".into());
}

#[test]
#[should_panic(expected = "only the ruler (for its chancellor) or the referee sets policy")]
fn a_ruler_cannot_raise_its_own_cap() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    c.set_policy(id, 0, ruler(0), 1_000_000, 1_000_000);
}

#[test]
#[should_panic(expected = "only the worker delivers")]
fn only_the_worker_delivers() {
    let (mut c, id) = setup();
    as_(ruler(0), 2_000);
    let job = c.hire(id, 0, spy(), JobKind::Spy, 10, "a".into());
    c.deliver(job, seal_hex(1));
}

#[test]
#[should_panic(expected = "only an approved referee can create campaigns")]
fn only_referees_create_campaigns() {
    let (mut c, _) = setup();
    as_(ruler(0), 2_000);
    c.create_campaign(vec![], "s".into(), ROLL_COMMIT.into(), vec![], 1, 1);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_creates_agents() {
    let (mut c, _) = setup();
    as_(ruler(0), 2_000);
    let _ = c.create_agent("spy".into(), "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap());
}

/// Every realm seals; realm 1 seals the shared test vector so it can reveal.
fn all_sealed() -> (RealmLedger, u64) {
    let (mut c, id) = setup();
    for i in 0..3 {
        as_(ruler(i), 2_000);
        c.seal(id, i as u8, if i == 1 { ORDERS_SEAL.into() } else { seal_hex(i as u8 + 1) });
    }
    (c, id)
}

#[test]
fn a_ruler_forfeit_settles_without_waiting() {
    let (mut c, id) = all_sealed();
    as_(ruler(0), 3_000);
    c.forfeit(id, 0, 0);
    assert!(c.get_forfeit(id, 0, 0));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"forfeited\"")));
    as_(ruler(1), 3_000);
    c.reveal(id, 1, ORDERS.into(), ORDERS_SALT.into());
    // the revealed orders are kept for the referee until the season settles
    assert_eq!(c.get_reveal(id, 0, 1), Some(RevealedOrders { orders: ORDERS.into(), salt: ORDERS_SALT.into() }));
    as_(ruler(2), 3_000);
    c.forfeit(id, 2, 0);
    as_(referee(), 4_000);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], Some(vec![0, 2]));
    assert_eq!(c.get_campaign(id).unwrap().season, 1);
    assert!(get_logs().iter().any(|l| l.contains("\"forfeited\":[0,2]")));
    // kept reveals are removed once settled; the forfeit mark stays as a record
    assert_eq!(c.get_reveal(id, 0, 1), None);
    assert!(c.get_forfeit(id, 0, 0));
}

#[test]
#[should_panic(expected = "this realm forfeited its orders this season")]
fn a_forfeit_blocks_a_later_reveal() {
    let (mut c, id) = all_sealed();
    as_(ruler(1), 3_000);
    c.forfeit(id, 1, 0);
    c.reveal(id, 1, ORDERS.into(), ORDERS_SALT.into());
}

#[test]
#[should_panic(expected = "a forfeited realm must have sealed and not revealed")]
fn a_realm_that_revealed_cannot_be_settled_as_forfeited() {
    let (mut c, id) = all_sealed();
    as_(ruler(1), 3_000);
    c.reveal(id, 1, ORDERS.into(), ORDERS_SALT.into());
    // even after the window: the reveal landed first, so its orders must count
    as_(referee(), 2_000 + SEASON_MS * 3);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], Some(vec![0, 1, 2]));
}

#[test]
#[should_panic(expected = "a realm can only be forfeited by its ruler or after the reveal window")]
fn the_referee_cannot_forfeit_a_realm_early() {
    let (mut c, id) = all_sealed();
    as_(referee(), 3_000);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], Some(vec![0, 1, 2]));
}

#[test]
fn the_referee_may_forfeit_after_the_reveal_window() {
    let (mut c, id) = all_sealed();
    as_(referee(), 1_000 + SEASON_MS * 2);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], Some(vec![0, 1, 2]));
    assert_eq!(c.get_campaign(id).unwrap().season, 1);
}

#[test]
#[should_panic(expected = "waiting for reveals")]
fn every_sealed_realm_is_revealed_or_forfeited() {
    let (mut c, id) = all_sealed();
    as_(ruler(0), 3_000);
    c.forfeit(id, 0, 0);
    as_(referee(), 3_000);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], Some(vec![0]));
}

#[test]
#[should_panic(expected = "only the ruler forfeits its orders")]
fn only_the_ruler_forfeits() {
    let (mut c, id) = all_sealed();
    as_(referee(), 3_000);
    c.forfeit(id, 0, 0);
}

#[test]
#[should_panic(expected = "that season is not the current one")]
fn a_forfeit_names_its_season() {
    let (mut c, id) = all_sealed();
    as_(ruler(0), 3_000);
    c.forfeit(id, 0, 1);
}

#[test]
fn agent_seat_reveals_are_not_kept() {
    // rulers that are sub-accounts of the contract are agent seats: the referee holds their orders
    let (mut c, _) = setup();
    let seat: AccountId = "ruler1.contract.testnet".parse().unwrap();
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id("contract.testnet".parse().unwrap());
    testing_env!(ctx.predecessor_account_id(referee()).block_timestamp(1_000 * 1_000_000).build());
    let realms = (0..2)
        .map(|i| RealmInit { ruler: if i == 1 { seat.clone() } else { ruler(i) }, chancellor: None, treasury: 0, season_cap: 0, campaign_cap: 0 })
        .collect();
    let commits = (0..2).map(|i| { let (a, s) = agenda(i); commitment(&a, &s) }).collect();
    let id2 = c.create_campaign(realms, "seed-2".into(), ROLL_COMMIT.into(), commits, 2, SEASON_MS);
    for (i, who) in [(0u8, ruler(0)), (1u8, seat.clone())] {
        testing_env!(VMContextBuilder::new().current_account_id("contract.testnet".parse().unwrap()).predecessor_account_id(who).block_timestamp(2_000 * 1_000_000).build());
        c.seal(id2, i, ORDERS_SEAL.into());
    }
    testing_env!(VMContextBuilder::new().current_account_id("contract.testnet".parse().unwrap()).predecessor_account_id(seat).block_timestamp(3_000 * 1_000_000).build());
    c.reveal(id2, 1, ORDERS.into(), ORDERS_SALT.into());
    assert_eq!(c.get_reveal(id2, 0, 1), None);
}

#[test]
#[should_panic(expected = "waiting for reveals")]
fn an_unrevealed_realm_must_be_named_even_after_the_window() {
    let (mut c, id) = all_sealed();
    as_(referee(), 1_000 + SEASON_MS * 3);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], None);
}

#[test]
#[should_panic(expected = "a realm is listed twice")]
fn a_forfeited_realm_is_listed_once() {
    let (mut c, id) = all_sealed();
    as_(referee(), 1_000 + SEASON_MS * 3);
    c.settle_season(id, seal_hex(9), vec![0, 0, 0], vec![], vec![], Some(vec![0, 0, 1, 2]));
}
