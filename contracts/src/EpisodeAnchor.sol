// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title EpisodeAnchor (v2, device-first)
/// @notice Write-once record of each Pearl episode on 0G Chain, written by the robot itself: the device's own
///         key sends the transaction, so the record is keyed by the device address (msg.sender). It holds the head of
///         the episode's hash-chained log, the 0G Storage root of the full log, a hash of the 0G Compute request ids,
///         the outcome and the incident severity. Nobody can change a record once written.
contract EpisodeAnchor {
    enum Outcome {
        DONE,
        ABORTED,
        FAILSAFE,
        TRIPPED
    }

    struct Anchor {
        bytes32 headHash;       // sha256 head of the episode's hash chain
        bytes32 rootHash;       // 0G Storage Merkle root of the canonical log (0 if storage failed)
        bytes32 requestIdsHash; // sha256 of the canonical JSON array of 0G request ids
        uint64 anchoredAt;      // block timestamp
        Outcome outcome;
        uint8 severity;         // 0..3 from the 0G INCIDENT decision, 0 when there was no incident
        bool incident;          // a safety event happened (hand in zone, bump, heartbeat loss, sensor fault)
    }

    mapping(address => mapping(bytes32 => Anchor)) private anchors; // device => keccak256(episodeId) => record
    mapping(address => uint256) public countOf;

    event EpisodeAnchored(
        address indexed device,
        bytes32 indexed episodeKey,
        bytes32 headHash,
        bytes32 rootHash,
        bytes32 requestIdsHash,
        Outcome outcome,
        uint8 severity,
        bool incident
    );

    error AlreadyAnchored(address device, bytes32 episodeKey);
    error EmptyHead();
    error BadSeverity(uint8 severity);

    function anchor(
        bytes32 episodeKey,
        bytes32 headHash,
        bytes32 rootHash,
        bytes32 requestIdsHash,
        Outcome outcome,
        uint8 severity,
        bool incident
    ) external {
        if (headHash == bytes32(0)) revert EmptyHead();
        if (severity > 3) revert BadSeverity(severity);
        Anchor storage a = anchors[msg.sender][episodeKey];
        if (a.anchoredAt != 0) revert AlreadyAnchored(msg.sender, episodeKey);
        anchors[msg.sender][episodeKey] =
            Anchor(headHash, rootHash, requestIdsHash, uint64(block.timestamp), outcome, severity, incident);
        unchecked {
            countOf[msg.sender]++;
        }
        emit EpisodeAnchored(msg.sender, episodeKey, headHash, rootHash, requestIdsHash, outcome, severity, incident);
    }

    function get(address device, bytes32 episodeKey) external view returns (Anchor memory) {
        return anchors[device][episodeKey];
    }
}
