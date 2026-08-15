import { STRING, Sequelize } from "sequelize";

export const define_initial_backup_checkpoints = (sequelize: Sequelize) => {
    const model = sequelize.define('initial_backup_checkpoints', {
        channelId: {
            type: STRING,
            primaryKey: true
        },
        status: {
            type: STRING,
            defaultValue: 'pending'
        },
        lastMessageId: {
            type: STRING
        }
    }, {freezeTableName: true})

    return model;
}
