package server

import (
	"log"

	"github.com/quic-go/webtransport-go"
)

// echoDatagrams sends every received datagram straight back until the session
// ends. It is the scaffold's connectivity check and will be replaced by the
// HTTP4 passive sender.
func echoDatagrams(sess *webtransport.Session) {
	ctx := sess.Context()
	for {
		b, err := sess.ReceiveDatagram(ctx)
		if err != nil {
			return
		}
		if err := sess.SendDatagram(b); err != nil {
			log.Printf("echo to %s: %v", sess.RemoteAddr(), err)
			return
		}
	}
}
