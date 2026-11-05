// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EpisodeAnchor} from "./EpisodeAnchor.sol";

/// @title RewardPool
/// @notice Pays test 0G to a person whose claim on a robot incident was approved. The operator (the dashboard backend)
///         calls payout only after the person passed World ID (Agent Pass + IDKit) and the episode verified. The
///         contract itself also refuses to pay unless the device anchored that incident on-chain with severity >= 2,
///         and pays each (incident, person) at most once. `claimant` is the IDKit nullifier, so no identity is on-chain.
contract RewardPool {
    EpisodeAnchor public immutable anchors;
    address public immutable operator;
    uint256 public immutable maxPayout;
    uint8 public constant MIN_SEVERITY = 2;

    mapping(bytes32 => bool) public paid; // keccak256(device, episodeKey, claimant)

    event Funded(address indexed from, uint256 amount);
    event Paid(address indexed device, bytes32 indexed episodeKey, bytes32 indexed claimant, address to, uint256 amount);

    error NotOperator();
    error NotAnIncident(address device, bytes32 episodeKey);
    error SeverityTooLow(uint8 severity);
    error AlreadyPaid(bytes32 claimKey);
    error AmountTooHigh(uint256 amount);
    error InsufficientPool(uint256 balance, uint256 amount);
    error TransferFailed();

    constructor(EpisodeAnchor anchors_, uint256 maxPayout_) {
        anchors = anchors_;
        operator = msg.sender;
        maxPayout = maxPayout_;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function claimKey(address device, bytes32 episodeKey, bytes32 claimant) public pure returns (bytes32) {
        return keccak256(abi.encode(device, episodeKey, claimant));
    }

    function payout(address device, bytes32 episodeKey, bytes32 claimant, address payable to, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator();
        EpisodeAnchor.Anchor memory a = anchors.get(device, episodeKey);
        if (a.anchoredAt == 0 || !a.incident) revert NotAnIncident(device, episodeKey);
        if (a.severity < MIN_SEVERITY) revert SeverityTooLow(a.severity);
        if (amount == 0 || amount > maxPayout) revert AmountTooHigh(amount);
        bytes32 k = claimKey(device, episodeKey, claimant);
        if (paid[k]) revert AlreadyPaid(k);
        if (address(this).balance < amount) revert InsufficientPool(address(this).balance, amount);
        paid[k] = true; // effects before the external call
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Paid(device, episodeKey, claimant, to, amount);
    }
}
