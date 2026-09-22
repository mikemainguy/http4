package sender

import "sync/atomic"

// Metrics are server-wide counters, shared by every session.
type Metrics struct {
	Sessions      atomic.Int64
	RPCs          atomic.Int64
	PacketsIn     atomic.Int64
	MalformedIn   atomic.Int64 // failed to decode, or a type the client must not send
	DataPackets   atomic.Int64
	DataBytes     atomic.Int64 // payload bytes, first transmissions and resends
	ResentBytes   atomic.Int64 // payload bytes sent in response to RESEND or a repeated REQ
	ErrorsSent    atomic.Int64
	ChunkShrinks  atomic.Int64 // times QUIC refused a datagram as too large
	RPCsEvicted   atomic.Int64
	UngrantedSent atomic.Int64 // G2: payload bytes sent past the RPC's grant; must stay 0
	DroppedData   atomic.Int64 // DATA packets discarded by loss injection (testing only)
	MetaPackets   atomic.Int64 // META packets sent, first transmissions and repeats
	DroppedMeta   atomic.Int64 // META packets discarded by loss injection (testing only)
	// Session sequence numbers (wire v2):
	HellosIn         atomic.Int64 // HELLO packets received
	DataSeqPackets   atomic.Int64 // DATA sent as DATA_SEQ (included in DataPackets)
	SeqResends       atomic.Int64 // RESEND_SEQ packets received
	SeqResendMisses  atomic.Int64 // sequence numbers asked for that the ring no longer held
	SeqResendRepeats atomic.Int64 // sequence numbers asked for again after they were already resent
	// Keeping QUIC's send queue shallow (pacer):
	SendBlocked     atomic.Int64 // sends that waited because QUIC's queue was full
	PacedWaits      atomic.Int64 // times the send loop held off to let the queue drain
	PacedWaitMicros atomic.Int64 // total time it held off
	PacerIntervalUs atomic.Int64 // last estimated time between departures, 0 while unmeasured
}

// Snapshot is Metrics as plain values, for JSON.
type Snapshot struct {
	Sessions         int64 `json:"sessions"`
	RPCs             int64 `json:"rpcs"`
	PacketsIn        int64 `json:"packets_in"`
	MalformedIn      int64 `json:"malformed_in"`
	DataPackets      int64 `json:"data_packets"`
	DataBytes        int64 `json:"data_bytes"`
	ResentBytes      int64 `json:"resent_bytes"`
	ErrorsSent       int64 `json:"errors_sent"`
	ChunkShrinks     int64 `json:"chunk_shrinks"`
	RPCsEvicted      int64 `json:"rpcs_evicted"`
	UngrantedSent    int64 `json:"ungranted_bytes_sent"`
	DroppedData      int64 `json:"dropped_data_packets"`
	MetaPackets      int64 `json:"meta_packets"`
	DroppedMeta      int64 `json:"dropped_meta_packets"`
	HellosIn         int64 `json:"hellos_in"`
	DataSeqPackets   int64 `json:"data_seq_packets"`
	SeqResends       int64 `json:"seq_resends"`
	SeqResendMisses  int64 `json:"seq_resend_misses"`
	SeqResendRepeats int64 `json:"seq_resend_repeats"`
	SendBlocked      int64 `json:"send_blocked"`
	PacedWaits       int64 `json:"paced_waits"`
	PacedWaitMicros  int64 `json:"paced_wait_micros"`
	PacerIntervalUs  int64 `json:"pacer_interval_us"`
}

func (m *Metrics) Snapshot() Snapshot {
	return Snapshot{
		Sessions:         m.Sessions.Load(),
		RPCs:             m.RPCs.Load(),
		PacketsIn:        m.PacketsIn.Load(),
		MalformedIn:      m.MalformedIn.Load(),
		DataPackets:      m.DataPackets.Load(),
		DataBytes:        m.DataBytes.Load(),
		ResentBytes:      m.ResentBytes.Load(),
		ErrorsSent:       m.ErrorsSent.Load(),
		ChunkShrinks:     m.ChunkShrinks.Load(),
		RPCsEvicted:      m.RPCsEvicted.Load(),
		UngrantedSent:    m.UngrantedSent.Load(),
		DroppedData:      m.DroppedData.Load(),
		MetaPackets:      m.MetaPackets.Load(),
		DroppedMeta:      m.DroppedMeta.Load(),
		HellosIn:         m.HellosIn.Load(),
		DataSeqPackets:   m.DataSeqPackets.Load(),
		SeqResends:       m.SeqResends.Load(),
		SeqResendMisses:  m.SeqResendMisses.Load(),
		SeqResendRepeats: m.SeqResendRepeats.Load(),
		SendBlocked:      m.SendBlocked.Load(),
		PacedWaits:       m.PacedWaits.Load(),
		PacedWaitMicros:  m.PacedWaitMicros.Load(),
		PacerIntervalUs:  m.PacerIntervalUs.Load(),
	}
}
