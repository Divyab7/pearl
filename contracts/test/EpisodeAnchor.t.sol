// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EpisodeAnchor} from "../src/EpisodeAnchor.sol";
import {RewardPool} from "../src/RewardPool.sol";

/// Minimal Foundry cheatcode interface (no forge-std dependency): https://getfoundry.sh/reference/cheatcodes/overview
interface Vm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
}

contract Receiver {
    receive() external payable {}
}

contract EpisodeAnchorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EpisodeAnchor a;
    RewardPool pool;
    address constant DEVICE = address(0xD1CE);
    address constant OTHER = address(0xBEEF);
    bytes32 constant KEY = keccak256("ep_20261105_ab12");
    bytes32 constant HEAD = bytes32(uint256(0x1234));
    bytes32 constant ROOT = bytes32(uint256(0x5678));
    bytes32 constant REQS = bytes32(uint256(0x9abc));
    bytes32 constant HUMAN = bytes32(uint256(0x4855));

    function setUp() public {
        a = new EpisodeAnchor();
        pool = new RewardPool(a, 1 ether);
        vm.deal(address(pool), 5 ether);
    }

    function anchorIncident(uint8 severity) internal {
        vm.prank(DEVICE);
        a.anchor(KEY, HEAD, ROOT, REQS, EpisodeAnchor.Outcome.TRIPPED, severity, true);
    }

    // ---- EpisodeAnchor ----
    function test_deviceAnchorsItsOwnRecord() public {
        vm.warp(1_793_000_000);
        anchorIncident(2);
        EpisodeAnchor.Anchor memory r = a.get(DEVICE, KEY);
        require(r.headHash == HEAD && r.rootHash == ROOT && r.requestIdsHash == REQS, "fields");
        require(r.anchoredAt == 1_793_000_000 && r.severity == 2 && r.incident, "meta");
        require(r.outcome == EpisodeAnchor.Outcome.TRIPPED, "outcome");
        require(a.countOf(DEVICE) == 1, "count");
        require(a.get(OTHER, KEY).anchoredAt == 0, "other device sees nothing");
    }

    function test_writeOncePerDevice() public {
        anchorIncident(2);
        vm.prank(DEVICE);
        vm.expectRevert(abi.encodeWithSelector(EpisodeAnchor.AlreadyAnchored.selector, DEVICE, KEY));
        a.anchor(KEY, bytes32(uint256(1)), ROOT, REQS, EpisodeAnchor.Outcome.DONE, 0, false);
    }

    function test_anotherDeviceCannotOverwrite() public {
        anchorIncident(2);
        vm.prank(OTHER);
        a.anchor(KEY, bytes32(uint256(9)), ROOT, REQS, EpisodeAnchor.Outcome.DONE, 0, false); // its own slot
        require(a.get(DEVICE, KEY).headHash == HEAD, "device record unchanged");
    }

    function test_rejectsEmptyHeadAndBadSeverity() public {
        vm.prank(DEVICE);
        vm.expectRevert(abi.encodeWithSelector(EpisodeAnchor.EmptyHead.selector));
        a.anchor(KEY, bytes32(0), ROOT, REQS, EpisodeAnchor.Outcome.DONE, 0, false);
        vm.prank(DEVICE);
        vm.expectRevert(abi.encodeWithSelector(EpisodeAnchor.BadSeverity.selector, uint8(4)));
        a.anchor(KEY, HEAD, ROOT, REQS, EpisodeAnchor.Outcome.DONE, 4, true);
    }

    // ---- RewardPool ----
    function test_paysVerifiedIncidentOncePerHuman() public {
        anchorIncident(2);
        Receiver r = new Receiver();
        pool.payout(DEVICE, KEY, HUMAN, payable(address(r)), 0.5 ether);
        require(address(r).balance == 0.5 ether, "paid");
        require(pool.paid(pool.claimKey(DEVICE, KEY, HUMAN)), "marked");
        vm.expectRevert(abi.encodeWithSelector(RewardPool.AlreadyPaid.selector, pool.claimKey(DEVICE, KEY, HUMAN)));
        pool.payout(DEVICE, KEY, HUMAN, payable(address(r)), 0.5 ether);
        // a different verified human may claim the same incident once
        pool.payout(DEVICE, KEY, bytes32(uint256(0x4856)), payable(address(r)), 0.5 ether);
        require(address(r).balance == 1 ether, "second human paid");
    }

    function test_onlyOperator() public {
        anchorIncident(2);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.NotOperator.selector));
        pool.payout(DEVICE, KEY, HUMAN, payable(OTHER), 0.1 ether);
    }

    function test_refusesWithoutAnAnchoredIncident() public {
        vm.expectRevert(abi.encodeWithSelector(RewardPool.NotAnIncident.selector, DEVICE, KEY));
        pool.payout(DEVICE, KEY, HUMAN, payable(OTHER), 0.1 ether);
        vm.prank(DEVICE);
        a.anchor(KEY, HEAD, ROOT, REQS, EpisodeAnchor.Outcome.DONE, 0, false);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.NotAnIncident.selector, DEVICE, KEY));
        pool.payout(DEVICE, KEY, HUMAN, payable(OTHER), 0.1 ether);
    }

    function test_refusesLowSeverityAndTooMuch() public {
        anchorIncident(1);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.SeverityTooLow.selector, uint8(1)));
        pool.payout(DEVICE, KEY, HUMAN, payable(OTHER), 0.1 ether);
        bytes32 k2 = keccak256("ep_2");
        vm.prank(DEVICE);
        a.anchor(k2, HEAD, ROOT, REQS, EpisodeAnchor.Outcome.TRIPPED, 3, true);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.AmountTooHigh.selector, 2 ether));
        pool.payout(DEVICE, k2, HUMAN, payable(OTHER), 2 ether);
    }

    function test_refusesWhenPoolIsEmpty() public {
        RewardPool small = new RewardPool(a, 10 ether);
        anchorIncident(3);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.InsufficientPool.selector, 0, 1 ether));
        small.payout(DEVICE, KEY, HUMAN, payable(OTHER), 1 ether);
    }
}
