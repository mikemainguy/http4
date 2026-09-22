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
}

// Snapshot is Metrics as plain values, for JSON.
type Snapshot struct {
	Sessions      int64 `json:"sessions"`
	RPCs          int64 `json:"rpcs"`
	PacketsIn     int64 `json:"packets_in"`
	MalformedIn   int64 `json:"malformed_in"`
	DataPackets   int64 `json:"data_packets"`
	DataBytes     int64 `json:"data_bytes"`
	ResentBytes   int64 `json:"resent_bytes"`
	ErrorsSent    int64 `json:"errors_sent"`
	ChunkShrinks  int64 `json:"chunk_shrinks"`
	RPCsEvicted   int64 `json:"rpcs_evicted"`
	UngrantedSent int64 `json:"ungranted_bytes_sent"`
	DroppedData   int64 `json:"dropped_data_packets"`
	MetaPackets   int64 `json:"meta_packets"`
	DroppedMeta   int64 `json:"dropped_meta_packets"`
}

func (m *Metrics) Snapshot() Snapshot {
	return Snapshot{
		Sessions:      m.Sessions.Load(),
		RPCs:          m.RPCs.Load(),
		PacketsIn:     m.PacketsIn.Load(),
		MalformedIn:   m.MalformedIn.Load(),
		DataPackets:   m.DataPackets.Load(),
		DataBytes:     m.DataBytes.Load(),
		ResentBytes:   m.ResentBytes.Load(),
		ErrorsSent:    m.ErrorsSent.Load(),
		ChunkShrinks:  m.ChunkShrinks.Load(),
		RPCsEvicted:   m.RPCsEvicted.Load(),
		UngrantedSent: m.UngrantedSent.Load(),
		DroppedData:   m.DroppedData.Load(),
		MetaPackets:   m.MetaPackets.Load(),
		DroppedMeta:   m.DroppedMeta.Load(),
	}
}
